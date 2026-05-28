/**
 * v2 Import Orchestrator — main entry point for importing v2 layered projects.
 *
 * Orchestration flow:
 *   Phase 0: Format detection — detect v1 vs v2, migrate v1 if needed
 *   Phase 1: Parse & Validate — stripCommonPrefix -> readFolderV2 -> detectLayers
 *            -> verifySHAIntegrity -> validateImport -> validateCrossLayerDeps
 *            If dryRun, return preview after disassembly/schema validation.
 *   Phase 2: Disassemble — for each requested layer, convert file maps to StagedRecord[]
 *     Wave 1: connections (must be first for auth profile resolution)
 *     Wave 2: core
 *     Wave 3: remaining layers in parallel
 *   Phase 3: Validate — entity schema validation via Zod .strip()
 *   Phase 4: Stage — write records with import lifecycle metadata via StagedImporter.stage()
 *   Phase 5: Cross-ref resolution — resolve inter-record foreign keys (records still staged)
 *   Phase 6: Activate — per-layer atomic swap (staged→visible, old→hidden/superseded)
 *   Phase 7: Post-import validation (if postImportDb provided)
 *   Return result with preview, operation ID, warnings
 *
 * For dry-run mode: stops before Phase 4 and returns preview without staging.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { computeSourceHash } from '@agent-platform/shared';
import {
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseDslProperties,
} from '@agent-platform/shared/tools';
import type {
  LayerName,
  ImportOptionsV2,
  ImportResultV2,
  ImportPreviewV2,
  ImportPhaseV2,
  ImportProgressEvent,
  ImportIssue,
  ImportBindingResolutionRequest,
  ImportBindingResolutionInput,
} from '../types.js';
import { readFolderV2, detectLayers, type FolderReadResultV2 } from './folder-reader.js';
import { extractToolsFromFiles } from './tool-extractor.js';
import { migrateV1ToV2 } from './v1-migration.js';
import { stripCommonPrefix } from './path-normalizer.js';
import { verifySHAIntegrity, validateImport, validateCrossLayerDeps } from './import-validator.js';
import { calculateImportDiffs } from '../diff/import-diff-calculator.js';
import { resolveImportedAgentIdentities } from './agent-identity-resolver.js';
import {
  StagedImporter,
  type ImportDbAdapter,
  type StagedRecord,
  type SupersededRecord,
} from './staged-importer.js';
import { validatePostImport, type PostImportDbAdapter } from './post-import-validator.js';
import { resolveCrossReferences, type CrossRefDbAdapter } from './cross-ref-resolver.js';
import { validateStagedRecordBatch } from './entity-schemas.js';
import {
  stripModelPolicyImportMetadata,
  stripRuntimeConfigSaveValidationMetadata,
  validateProjectModelPolicyConfigWrite,
} from './runtime-config-save-validation.js';
import { isMcpServerConfigFilePath } from '../mcp-server-config-io.js';
import type { ExistingProjectState } from './project-importer.js';
import type {
  DisassembleContext,
  DisassembleResult,
  LayerDisassembler,
} from './layer-disassemblers/types.js';
import type { CoreImportEvalStateV2 } from './core-direct-eval-apply.js';

const log = createLogger('project-importer-v2');

// ── Wave ordering for disassembly ──

/** Wave 1: Infrastructure layers (no cross-layer refs in disassembly) */
const DISASSEMBLY_WAVE_1: LayerName[] = ['connections', 'prompts'];

/** Wave 2: Core layer (may need connection name->ID resolution) */
const DISASSEMBLY_WAVE_2: LayerName[] = ['core'];

/** Wave 3: All other layers (parallel, reference core entities by name) */
const DISASSEMBLY_WAVE_3: LayerName[] = [
  'search',
  'workflows',
  'guardrails',
  'evals',
  'channels',
  'vocabulary',
];

const CROSS_REF_REQUIRED_LAYERS: LayerName[] = [
  'workflows',
  'evals',
  'search',
  'channels',
  'guardrails',
];

class ImportV2PhaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportV2PhaseError';
  }
}

// ── Dependency injection types ──

export interface ImportV2Deps {
  /** Layer disassemblers — convert file maps to StagedRecord[] */
  disassemblers: Map<LayerName, LayerDisassembler>;
  /**
   * Direct-apply callers may reuse v2 validation in dry-run mode for layers
   * that are applied outside the staged-record pipeline. Those layers do not
   * need a disassembler for preview-only validation.
   */
  allowMissingDisassemblersForDryRun?: readonly LayerName[];
  /** Database adapter for StagedImporter */
  dbAdapter: ImportDbAdapter;
  /** Optional adapter for post-import validation */
  postImportDb?: PostImportDbAdapter;
  /** Optional cross-reference resolver database adapter */
  crossRefDb?: CrossRefDbAdapter;
}

export interface ExistingProjectStateV2 extends ExistingProjectState {
  /** Existing active records per collection, for superseding during staged import */
  activeRecords: Map<string, Array<{ _id: string; [key: string]: unknown }>>;
  /** Existing eval state for direct apply paths that bypass staged activation. */
  evals?: CoreImportEvalStateV2;
  /** Existing project runtime config for direct apply/import-revert paths. */
  runtimeConfig?: Record<string, unknown> | null;
  /** Existing canonical project LLM config for direct apply/import-revert paths. */
  llmConfig?: Record<string, unknown> | null;
  /** Existing project model pool configs keyed by display name. */
  projectModelConfigs?: Map<string, { name: string; data: Record<string, unknown> }>;
  /** Existing per-agent model configs keyed by agent name. */
  agentModelConfigs?: Map<string, { agentName: string; data: Record<string, unknown> }>;
}

// Re-export CrossRefDbAdapter for consumers that need it
export type { CrossRefDbAdapter } from './cross-ref-resolver.js';

// ── Progress helper ──

function emitProgress(
  onProgress: ImportOptionsV2['onProgress'],
  event: Partial<ImportProgressEvent> & { phase: ImportPhaseV2 },
): void {
  if (!onProgress) return;
  onProgress({
    progress: 0,
    message: '',
    timestamp: Date.now(),
    ...event,
  });
}

// ── Main orchestrator ──

/**
 * Import a project using the v2 layered model.
 *
 * @param files - Map of relativePath -> content (from upload or git pull)
 * @param existingState - Current project state including active records for diffing/superseding
 * @param options - Import configuration (projectId, tenantId, layers, dryRun, etc.)
 * @param deps - Injected dependencies (db adapter, disassemblers, cross-ref resolver)
 * @returns Import result with preview, operation ID, and warnings
 */
export async function importProjectV2(
  files: Map<string, string>,
  existingState: ExistingProjectStateV2,
  options: ImportOptionsV2,
  deps: ImportV2Deps,
): Promise<ImportResultV2> {
  const allWarnings: string[] = [];
  let operationId = '';
  let currentPreview: ImportPreviewV2 | undefined;

  try {
    // ── Phase 0: Path Normalization & Format Detection ──

    emitProgress(options.onProgress, {
      phase: 'validating',
      message: 'Normalizing paths',
      progress: 0.02,
    });

    // Strip common prefix FIRST — zip uploads often wrap files in a directory
    // (e.g. "retail-voice-demo/project.json"). Must strip before migrateV1ToV2
    // which looks for "project.json" by exact key.
    const { files: strippedFiles } = stripCommonPrefix(files);

    emitProgress(options.onProgress, {
      phase: 'validating',
      message: 'Detecting format version',
      progress: 0.03,
    });

    const migration = migrateV1ToV2(strippedFiles);
    if (migration.error) {
      return buildErrorResult(migration.error.code, migration.error.message);
    }
    if (migration.migrated) {
      allWarnings.push(...migration.warnings);
    }

    const normalizedFiles = migration.files;
    const manifest = migration.manifest;

    // ── Phase 1: Parse & Validate ──

    emitProgress(options.onProgress, {
      phase: 'validating',
      message: 'Parsing folder structure',
      progress: 0.05,
    });

    // Read folder structure (use normalizedFiles which has stripped paths + migrated content)
    const folderResult = readFolderV2(normalizedFiles);
    if (!folderResult.success) {
      const requestedMissingLayer = findRequestedLayerMissingFiles(
        folderResult.errors,
        options.layers,
      );
      if (requestedMissingLayer) {
        return buildErrorResult(
          'REQUESTED_LAYER_MISSING_FILES',
          `Requested layer "${requestedMissingLayer}" has no matching archive files`,
        );
      }
      return buildErrorResult(
        'FOLDER_READ_FAILED',
        `Folder parsing failed: ${folderResult.errors.join('; ')}`,
      );
    }
    allWarnings.push(...folderResult.warnings);

    // Detect which layers are present in the import
    const detectedLayers = detectLayers(folderResult);

    // Intersect detected layers with requested layers (if specified)
    const importLayers: LayerName[] = options.layers
      ? detectedLayers.filter((l) => options.layers!.includes(l))
      : detectedLayers;

    if (importLayers.length === 0) {
      return buildErrorResult('NO_LAYERS', 'No importable layers found in the uploaded files');
    }
    const dryRunDisassemblerAllowlist = new Set(
      options.dryRun ? (deps.allowMissingDisassemblersForDryRun ?? []) : [],
    );
    const missingDisassemblers = importLayers.filter(
      (layer) =>
        layer !== 'core' &&
        !deps.disassemblers.has(layer) &&
        !dryRunDisassemblerAllowlist.has(layer),
    );
    if (missingDisassemblers.length > 0) {
      return buildErrorResult(
        'MISSING_LAYER_DISASSEMBLER',
        `Missing disassembler(s) for requested import layer(s): ${missingDisassemblers.join(', ')}`,
      );
    }

    // SHA integrity verification (warn on mismatch, never block)
    emitProgress(options.onProgress, {
      phase: 'validating',
      message: 'Verifying SHA integrity',
      progress: 0.1,
    });

    let shaResult = buildDefaultShaResult();
    if (folderResult.lockfileV2 && !migration.skipLockfileVerification) {
      shaResult = verifySHAIntegrity(folderResult.lockfileV2, normalizedFiles);
    } else if (migration.skipLockfileVerification) {
      allWarnings.push('SHA verification skipped for v1 imports (lockfile format incompatible)');
    }

    // Syntax validation
    const syntaxResult = validateImport(
      folderResult.agentFiles,
      folderResult.toolFiles,
      folderResult.profileFiles,
    );

    // Cross-layer dependency validation
    const crossLayerResult = validateCrossLayerDeps(folderResult);
    const agentIdentity = resolveImportedAgentIdentities(
      folderResult.agentFiles,
      folderResult.manifestV2 ?? folderResult.manifest,
    );
    const toolExtraction = extractToolsFromFiles(folderResult.toolFiles);
    const localeChanges = buildLocaleChanges(folderResult, existingState);
    const profileChanges = buildProfileChanges(folderResult, existingState);

    // Compute agent and tool diffs against existing state for accurate preview
    const agentChanges = buildAgentChanges(agentIdentity, existingState);
    const toolChanges = buildToolChanges(toolExtraction, existingState);
    const issues = buildImportIssues({
      syntaxErrors: syntaxResult.syntaxErrors,
      crossLayerResult,
      shaResult,
      toolExtraction,
      agentIdentity,
    });
    const blockingIssueCount = issues.filter((issue) => issue.blocking).length;
    const nonBlockingIssueCount = issues.length - blockingIssueCount;
    const hasBlockingIssues = blockingIssueCount > 0;

    // Build preview
    const preview: ImportPreviewV2 = {
      valid: !hasBlockingIssues,
      formatVersion: folderResult.formatVersion,
      layers: importLayers,
      layerChanges: buildLayerChanges(
        folderResult,
        importLayers,
        existingState,
        agentIdentity,
        toolExtraction,
      ),
      agentChanges,
      toolChanges,
      localeChanges,
      profileChanges,
      shaIntegrity: {
        valid: shaResult.valid,
        integrityMatch: shaResult.integrityMatch,
        layerResults: shaResult.layerResults,
        errors: shaResult.errors,
        warnings: shaResult.warnings,
      },
      crossLayerDeps: {
        valid: crossLayerResult.valid,
        missingDependencies: crossLayerResult.missingDependencies,
        warnings: crossLayerResult.warnings,
      },
      syntaxErrors: syntaxResult.syntaxErrors,
      issues,
      hasBlockingIssues,
      requiresAcknowledgement: nonBlockingIssueCount > 0,
      blockingIssueCount,
      nonBlockingIssueCount,
      entryAgentResolution: agentIdentity.entryAgent,
      warnings: [...allWarnings],
    };
    currentPreview = preview;

    emitProgress(options.onProgress, {
      phase: 'validating',
      message: 'Validation complete',
      progress: 0.15,
    });

    // ── Phase 2: Disassemble (file maps -> StagedRecord[]) ──

    emitProgress(options.onProgress, {
      phase: 'staging',
      message: 'Starting layer disassembly',
      progress: 0.16,
    });

    const allRecords: StagedRecord[] = [];
    const allSuperseded: SupersededRecord[] = [];

    function buildLayerCtx(layer: LayerName): DisassembleContext {
      return {
        files: folderResult.layerFiles[layer] ?? new Map(),
        projectId: options.projectId,
        tenantId: options.tenantId,
        userId: options.userId,
        conflictStrategy: options.conflictStrategy,
        existingRecordIds: existingState.activeRecords,
        authProfileMapping: options.authProfileMapping,
        manifestMetadata: manifest?.metadata
          ? {
              required_auth_profiles: manifest.metadata.required_auth_profiles?.map((p) => ({
                name: p.name,
                authType: p.authType,
                scope: p.scope,
                referencedBy: p.referencedBy,
              })),
              entity_counts: manifest.metadata.entity_counts,
            }
          : undefined,
        manifestAgents: manifest?.agents,
      };
    }

    // Wave 1: connections (must be first for auth profile resolution)
    await disassembleWave(
      DISASSEMBLY_WAVE_1,
      importLayers,
      deps.disassemblers,
      buildLayerCtx,
      allRecords,
      allSuperseded,
      allWarnings,
      options.onProgress,
      0.16,
      0.25,
    );

    // Wave 2: core
    await disassembleWave(
      DISASSEMBLY_WAVE_2,
      importLayers,
      deps.disassemblers,
      buildLayerCtx,
      allRecords,
      allSuperseded,
      allWarnings,
      options.onProgress,
      0.25,
      0.35,
    );

    // Wave 3: remaining layers in parallel
    const wave3Layers = DISASSEMBLY_WAVE_3.filter((l) => importLayers.includes(l));
    const wave3Promises = wave3Layers.map(async (layer) => {
      const disassembler = deps.disassemblers.get(layer);
      if (!disassembler) return { records: [], superseded: [], warnings: [] } as DisassembleResult;
      try {
        return await disassembler.disassemble(buildLayerCtx(layer));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Disassembly failed for layer', { layer, error: message });
        throw new ImportV2PhaseError(
          'DISASSEMBLY_FAILED',
          `Layer "${layer}" disassembly failed: ${message}`,
        );
      }
    });

    const wave3Results = await Promise.all(wave3Promises);
    for (const result of wave3Results) {
      allRecords.push(...result.records);
      allSuperseded.push(...result.superseded);
      allWarnings.push(...result.warnings);
    }

    for (const record of allRecords) {
      if (record.collection !== 'project_agents' || typeof record.data.name !== 'string') {
        continue;
      }
      const agent = agentIdentity.agents.get(record.data.name);
      if (!agent) {
        continue;
      }
      record.data.description = agent.description;
      record.data.systemPromptLibraryRef = agent.systemPromptLibraryRef;
    }
    normalizeImportedRecordOwnership(allRecords, {
      tenantId: options.tenantId,
      projectId: options.projectId,
      userId: options.userId,
    });
    allWarnings.push(...buildUnfulfilledModelConfigWarnings(allRecords));

    emitProgress(options.onProgress, {
      phase: 'staging',
      message: `Disassembly complete — ${allRecords.length} records to stage`,
      progress: 0.45,
    });

    if (allRecords.length === 0) {
      return {
        success: true,
        operationId: '',
        phase: 'completed',
        preview,
        warnings: options.dryRun
          ? allWarnings
          : [...allWarnings, 'No records produced by disassembly — nothing to import'],
      };
    }

    // ── Phase 3: Entity schema validation ──

    emitProgress(options.onProgress, {
      phase: 'staging',
      message: 'Validating entity schemas',
      progress: 0.46,
    });

    let {
      sanitized: validatedRecords,
      warnings: schemaWarnings,
      errors: schemaErrors = [],
    } = validateStagedRecordBatch(allRecords);
    allWarnings.push(...schemaWarnings);
    if (schemaErrors.length > 0) {
      return buildErrorResult('ENTITY_SCHEMA_VALIDATION_FAILED', schemaErrors.join('; '));
    }

    const toolValidation = await validateLayeredToolRecords({
      records: validatedRecords,
      options,
    });
    if (!toolValidation.success) {
      return buildErrorResult('TOOL_SAVE_VALIDATION_FAILED', toolValidation.message);
    }
    if (toolValidation.issues.length > 0) {
      preview.bindingResolutionRequests = toolValidation.bindingResolutionRequests;
      for (const issue of toolValidation.issues) {
        pushIssue(preview.issues, issue);
      }
      refreshPreviewIssueCounts(preview);
      currentPreview = preview;
    }

    const runtimeConfigValidation = await validateLayeredRuntimeConfigRecords({
      records: validatedRecords,
      options,
    });
    if (!runtimeConfigValidation.success) {
      return buildErrorResult(
        'RUNTIME_CONFIG_SAVE_VALIDATION_FAILED',
        runtimeConfigValidation.message,
      );
    }
    validatedRecords = runtimeConfigValidation.records;
    const effectiveImportLayers = [
      ...new Set<LayerName>([
        ...importLayers,
        ...validatedRecords.map((record) => record.layer),
        ...allSuperseded.map((record) => record.layer),
      ]),
    ];
    const partialReferenceIssues = buildPartialLayerReferenceIssues({
      records: validatedRecords,
      importLayers,
      existingState,
    });
    if (partialReferenceIssues.length > 0) {
      for (const issue of partialReferenceIssues) {
        pushIssue(preview.issues, issue);
      }
      refreshPreviewIssueCounts(preview);
      currentPreview = preview;
    }

    // ── Dry-run: return preview after validating the import plan ──

    if (options.dryRun) {
      return {
        success: true,
        operationId: '',
        phase: 'completed',
        preview,
        warnings: allWarnings,
      };
    }

    const crossRefRequiredLayers = CROSS_REF_REQUIRED_LAYERS.filter((layer) =>
      effectiveImportLayers.includes(layer),
    );
    if (
      effectiveImportLayers.includes('vocabulary') &&
      validatedRecords.some(
        (record) =>
          record.data._vocabularyKnowledgeBaseId !== undefined ||
          record.data._schemaKnowledgeBaseId !== undefined,
      )
    ) {
      crossRefRequiredLayers.push('vocabulary');
    }
    if (
      effectiveImportLayers.includes('connections') &&
      validatedRecords.some((record) => record.data._connectorConfigSourceId !== undefined)
    ) {
      crossRefRequiredLayers.push('connections');
    }
    if (!deps.crossRefDb && crossRefRequiredLayers.length > 0) {
      const message =
        `Cross-reference resolver is required for requested layer(s): ` +
        `${crossRefRequiredLayers.join(', ')}. Provide crossRefDb in ImportV2Deps for complete import.`;
      log.warn('Cross-ref resolver not provided for layers with cross-references', {
        affectedLayers: crossRefRequiredLayers,
      });
      return {
        success: false,
        operationId: '',
        phase: 'failed',
        preview,
        warnings: allWarnings,
        error: {
          code: 'CROSS_REF_RESOLVER_REQUIRED',
          message,
        },
      };
    }

    // ── Phase 4: Stage (records written with import lifecycle metadata) ──

    emitProgress(options.onProgress, {
      phase: 'staging',
      message: 'Staging records',
      progress: 0.5,
    });

    const importer = new StagedImporter(deps.dbAdapter);

    // Create import operation record
    const layerStatuses: Record<string, { status: string }> = {};
    for (const layer of effectiveImportLayers) {
      layerStatuses[layer] = { status: 'pending' };
    }
    const importOperation = await deps.dbAdapter.createImportOperation({
      projectId: options.projectId,
      tenantId: options.tenantId,
      layers: layerStatuses,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    operationId = importOperation._id;

    const stageResult = await importer.stage(
      operationId,
      options.projectId,
      options.tenantId,
      validatedRecords,
      effectiveImportLayers,
    );

    if (!stageResult.success) {
      await deps.dbAdapter.updateImportOperation(operationId, options.projectId, options.tenantId, {
        status: 'failed',
        error: stageResult.error,
      });
      return {
        success: false,
        operationId,
        phase: 'failed',
        preview,
        warnings: allWarnings,
        error: {
          code: 'STAGING_FAILED',
          message: stageResult.error
            ? `${stageResult.error.phase}/${stageResult.error.layer}: ${stageResult.error.message}`
            : 'Unknown staging failure',
        },
      };
    }

    // ── Phase 5: Cross-reference resolution ──
    // Runs AFTER staging (records have new _ids) but BEFORE activation
    // (records are still marked as staged — queryable by the resolver).

    if (deps.crossRefDb) {
      emitProgress(options.onProgress, {
        phase: 'resolving_refs',
        message: 'Resolving cross-references',
        progress: 0.65,
      });

      try {
        const crossRefResult = await resolveCrossReferences(
          deps.crossRefDb,
          operationId,
          stageResult.stagedRecordIds,
        );
        allWarnings.push(...crossRefResult.warnings);
        log.info('Cross-reference resolution complete', {
          operationId,
          resolved: crossRefResult.resolved,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Cross-reference resolution failed', {
          operationId,
          error: message,
        });
        try {
          await deps.dbAdapter.updateImportOperation(
            operationId,
            options.projectId,
            options.tenantId,
            { status: 'rolling_back' },
          );
          await importer.rollback(
            operationId,
            options.projectId,
            options.tenantId,
            stageResult.stagedRecordIds,
            {},
            [],
          );
        } catch (rollbackErr) {
          const rollbackMessage =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          allWarnings.push(`Rollback after cross-reference failure failed: ${rollbackMessage}`);
          log.error('Rollback failed after cross-reference resolution failure', {
            operationId,
            error: rollbackMessage,
          });
        }
        await deps.dbAdapter.updateImportOperation(
          operationId,
          options.projectId,
          options.tenantId,
          {
            status: 'failed',
            error: {
              phase: 'resolving_refs',
              layer: 'all',
              message,
            },
          },
        );
        return {
          success: false,
          operationId,
          phase: 'failed',
          preview,
          warnings: allWarnings,
          error: {
            code: 'CROSS_REF_RESOLUTION_FAILED',
            message: `Cross-reference resolution failed: ${message}`,
          },
        };
      }
    }

    // ── Phase 6: Activate (staged→visible, old→hidden/superseded) ──

    emitProgress(options.onProgress, {
      phase: 'activating',
      message: 'Activating records',
      progress: 0.75,
    });

    await deps.dbAdapter.updateImportOperation(operationId, options.projectId, options.tenantId, {
      status: 'activating',
      stagedRecordIds: stageResult.stagedRecordIds,
    });

    const activateResult = await importer.activate(
      operationId,
      options.projectId,
      options.tenantId,
      stageResult.stagedRecordIds,
      allSuperseded,
      effectiveImportLayers,
    );

    if (!activateResult.success) {
      try {
        await deps.dbAdapter.updateImportOperation(
          operationId,
          options.projectId,
          options.tenantId,
          { status: 'rolling_back' },
        );
        await importer.rollback(
          operationId,
          options.projectId,
          options.tenantId,
          stageResult.stagedRecordIds,
          activateResult.supersededRecordIds,
          activateResult.activatedLayers,
        );
        await deps.dbAdapter.updateImportOperation(
          operationId,
          options.projectId,
          options.tenantId,
          { status: 'failed', error: activateResult.error },
        );
      } catch (rollbackErr) {
        const rollbackMsg =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        log.error('Rollback failed after activation failure', {
          operationId,
          error: rollbackMsg,
        });
        // Best-effort: try to mark operation as failed even if rollback threw
        try {
          await deps.dbAdapter.updateImportOperation(
            operationId,
            options.projectId,
            options.tenantId,
            {
              status: 'failed',
              error: {
                phase: 'rollback',
                layer: 'all',
                message: `Rollback failed: ${rollbackMsg}`,
              },
            },
          );
        } catch {
          // Nothing more we can do — operation is stuck
          log.error('Failed to mark operation as failed after rollback error', { operationId });
        }
      }
      return {
        success: false,
        operationId,
        phase: 'failed',
        preview,
        warnings: allWarnings,
        error: {
          code: 'ACTIVATION_FAILED',
          message: activateResult.error
            ? `${activateResult.error.phase}/${activateResult.error.layer}: ${activateResult.error.message}`
            : 'Unknown activation failure',
        },
      };
    }

    // Mark operation completed
    await deps.dbAdapter.updateImportOperation(operationId, options.projectId, options.tenantId, {
      status: 'completed',
      supersededRecordIds: activateResult.supersededRecordIds,
    });

    // Fire-and-forget cleanup of superseded records (TTL-based retry as safety net)
    for (const [collection, ids] of Object.entries(activateResult.supersededRecordIds)) {
      if (ids.length > 0) {
        deps.dbAdapter.deleteRecordsByIds(collection, ids).catch((err) => {
          log.warn('Cleanup of superseded records failed (will retry via TTL)', {
            operationId,
            collection,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // ── Phase 7: Post-import validation ──

    emitProgress(options.onProgress, {
      phase: 'completed',
      message: 'Running post-import validation',
      progress: 0.9,
    });

    let postImportReport;
    if (deps.postImportDb) {
      try {
        postImportReport = await validatePostImport(
          {
            projectId: options.projectId,
            tenantId: options.tenantId,
            importedLayers: effectiveImportLayers,
            referencedEnvVars: manifest?.metadata.required_env_vars ?? [],
            referencedConnectors: manifest?.metadata.required_connectors ?? [],
            referencedMCPServers: manifest?.metadata.required_mcp_servers ?? [],
            referencedAuthProfiles: manifest?.metadata.required_auth_profiles?.map((p) => p.name),
            layerCounts: buildLayerCounts(folderResult, effectiveImportLayers),
          },
          deps.postImportDb,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        allWarnings.push(`Post-import validation failed: ${message}`);
      }
    }

    emitProgress(options.onProgress, {
      phase: 'completed',
      message: 'Import complete',
      progress: 1.0,
    });

    log.info('Import v2 completed', {
      operationId,
      projectId: options.projectId,
      layers: effectiveImportLayers,
      recordCount: validatedRecords.length,
    });

    return {
      success: true,
      operationId,
      phase: 'completed',
      preview,
      postImportReport,
      warnings: allWarnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const phaseError = err instanceof ImportV2PhaseError ? err : null;
    log.error('Import v2 failed with unexpected error', {
      projectId: options.projectId,
      operationId,
      error: message,
    });

    // Best-effort: mark operation as failed if we have an operationId
    if (operationId) {
      try {
        await deps.dbAdapter.updateImportOperation(
          operationId,
          options.projectId,
          options.tenantId,
          {
            status: 'failed',
            error: { phase: 'unknown', layer: 'unknown', message },
          },
        );
      } catch {
        log.error('Failed to mark operation as failed during error recovery', { operationId });
      }
    }

    return {
      success: false,
      operationId,
      phase: 'failed' as const,
      preview:
        currentPreview ?? buildErrorResult(phaseError?.code ?? 'IMPORT_FAILED', message).preview,
      warnings: allWarnings,
      error: {
        code: phaseError?.code ?? 'IMPORT_FAILED',
        message: phaseError ? message : `Unexpected error: ${message}`,
      },
    };
  }
}

// ── Helpers ──

function findRequestedLayerMissingFiles(
  errors: string[],
  requestedLayers: LayerName[] | undefined,
): LayerName | null {
  if (!requestedLayers || requestedLayers.length === 0) {
    return null;
  }

  for (const layer of requestedLayers) {
    const hasMissingLayerError = errors.some(
      (error) =>
        error.includes(`Layer "${layer}"`) &&
        error.includes('declared') &&
        error.includes('no matching archive files'),
    );
    if (hasMissingLayerError) {
      return layer;
    }
  }

  return null;
}

function normalizeImportedRecordOwnership(
  records: StagedRecord[],
  options: Pick<ImportOptionsV2, 'tenantId' | 'projectId' | 'userId'>,
): void {
  for (const record of records) {
    record.data.tenantId = options.tenantId;
    record.data.projectId = options.projectId;
    if (record.data.createdBy === undefined || record.data.createdBy === null) {
      record.data.createdBy = options.userId;
    }
  }
}

function containsProjectModelConfigReference(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsProjectModelConfigReference(entry));
  }

  if (!value || typeof value !== 'object') {
    return false;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'projectModelConfigId' && typeof entry === 'string' && entry.trim().length > 0) {
      return true;
    }
    if (containsProjectModelConfigReference(entry)) {
      return true;
    }
  }

  return false;
}

function buildUnfulfilledModelConfigWarnings(records: StagedRecord[]): string[] {
  const hasImportedProjectModelConfig = records.some(
    (record) => record.collection === 'model_configs',
  );
  if (hasImportedProjectModelConfig) {
    return [];
  }

  const runtimeConfigWithExternalModel = records.find(
    (record) =>
      record.collection === 'project_runtime_configs' &&
      containsProjectModelConfigReference(record.data),
  );
  if (!runtimeConfigWithExternalModel) {
    return [];
  }

  return [
    'Imported runtime configuration references a project model config that is not present in the archive; preserving it as unfulfilled model config state for target-project resolution.',
  ];
}

function buildPartialLayerReferenceIssues(input: {
  records: StagedRecord[];
  importLayers: LayerName[];
  existingState: ExistingProjectStateV2;
}): Array<Omit<ImportIssue, 'id'>> {
  if (input.importLayers.includes('core')) {
    return [];
  }

  const issues: Array<Omit<ImportIssue, 'id'>> = [];
  const seen = new Set<string>();
  for (const record of input.records) {
    if (record.collection !== 'guardrail_policies') {
      continue;
    }

    const agentName = record.data._guardrailAgentName ?? record.data.scope;
    const scopedAgentName =
      typeof agentName === 'string'
        ? agentName
        : typeof agentName === 'object' &&
            agentName !== null &&
            'agentName' in agentName &&
            typeof (agentName as { agentName?: unknown }).agentName === 'string'
          ? (agentName as { agentName: string }).agentName
          : null;

    if (!scopedAgentName || input.existingState.agents.has(scopedAgentName)) {
      continue;
    }

    const issueKey = `${record.collection}:${scopedAgentName}`;
    if (seen.has(issueKey)) {
      continue;
    }
    seen.add(issueKey);
    issues.push({
      severity: 'error',
      blocking: true,
      category: 'dependency',
      code: 'E_IMPORT_PARTIAL_LAYER_AGENT_REFERENCE',
      file: recordSourceFile(record) ?? record.collection,
      message: `Imported ${record.layer} record references agent "${scopedAgentName}", but the core layer is not selected and the target project does not contain that agent.`,
    });
  }

  return issues;
}

/**
 * Disassemble a sequential wave of layers, accumulating results.
 * Errors at layer boundaries fail the import because requested layers must be applied
 * completely or not at all.
 */
async function disassembleWave(
  waveLayers: LayerName[],
  importLayers: LayerName[],
  disassemblers: Map<LayerName, LayerDisassembler>,
  buildCtx: (layer: LayerName) => DisassembleContext,
  allRecords: StagedRecord[],
  allSuperseded: SupersededRecord[],
  allWarnings: string[],
  onProgress: ImportOptionsV2['onProgress'],
  progressStart: number,
  progressEnd: number,
): Promise<void> {
  const activeLayers = waveLayers.filter((l) => importLayers.includes(l));
  const perLayer =
    activeLayers.length > 0 ? (progressEnd - progressStart) / activeLayers.length : 0;

  for (let i = 0; i < activeLayers.length; i++) {
    const layer = activeLayers[i];
    const disassembler = disassemblers.get(layer);
    if (!disassembler) continue;

    emitProgress(onProgress, {
      phase: 'staging',
      layer,
      message: `Disassembling ${layer} layer`,
      progress: progressStart + i * perLayer,
    });

    try {
      const result = await disassembler.disassemble(buildCtx(layer));
      allRecords.push(...result.records);
      allSuperseded.push(...result.superseded);
      allWarnings.push(...result.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Disassembly failed for layer', { layer, error: message });
      throw new ImportV2PhaseError(
        'DISASSEMBLY_FAILED',
        `Layer "${layer}" disassembly failed: ${message}`,
      );
    }
  }
}

function recordSourceFile(record: StagedRecord): string | null {
  const sourceFile = record.data.sourceFile;
  return typeof sourceFile === 'string' && sourceFile.length > 0 ? sourceFile : null;
}

function isSupportedProjectToolType(
  toolType: unknown,
): toolType is 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow' {
  return (
    toolType === 'http' ||
    toolType === 'mcp' ||
    toolType === 'sandbox' ||
    toolType === 'searchai' ||
    toolType === 'workflow'
  );
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

interface ImportedToolDslNormalization {
  dslContent: string;
  searchAiTenantId?: string;
  searchAiIndexExportedId?: string;
  searchAiKbName?: string;
  workflowToolExportedWorkflowId?: string;
  workflowToolExportedTriggerId?: string;
  workflowToolExportedVersion?: string;
}

function normalizeImportedToolDslForTarget(input: {
  toolType: 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow';
  dslContent: string;
  tenantId: string;
}): ImportedToolDslNormalization {
  if (input.toolType !== 'searchai') {
    if (input.toolType !== 'workflow') {
      return { dslContent: input.dslContent };
    }

    try {
      const binding = buildWorkflowBindingFromProps(parseDslProperties(input.dslContent));
      return {
        dslContent: input.dslContent,
        workflowToolExportedWorkflowId: binding.workflowId,
        workflowToolExportedTriggerId: binding.triggerId,
        workflowToolExportedVersion: binding.workflowVersion,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug('Deferring malformed imported workflow binding to canonical validation', {
        error: message,
      });
      return { dslContent: input.dslContent };
    }
  }

  let searchAiTenantId: string | undefined;
  let searchAiIndexExportedId: string | undefined;
  let searchAiKbName: string | undefined;
  try {
    const binding = buildSearchAIBindingFromProps(parseDslProperties(input.dslContent));
    if (binding.tenantId) {
      searchAiTenantId = binding.tenantId;
    }
    if (binding.indexId) {
      searchAiIndexExportedId = binding.indexId;
    }
    if (binding.kbName) {
      searchAiKbName = binding.kbName;
    }
  } catch (err) {
    // Canonical save validation below will surface malformed bindings with its normal diagnostics.
    const message = err instanceof Error ? err.message : String(err);
    log.debug('Deferring malformed imported SearchAI binding to canonical validation', {
      error: message,
    });
  }

  return {
    dslContent: upsertIndentedDslProperty(input.dslContent, 'tenant_id', input.tenantId),
    searchAiTenantId,
    searchAiIndexExportedId,
    searchAiKbName,
  };
}

function collectImportedSearchIndexExportedIds(records: StagedRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.collection !== 'search_indexes') {
      continue;
    }
    const exportedId = record.data._exportedId;
    if (typeof exportedId === 'string' && exportedId.length > 0) {
      ids.add(exportedId);
    }
  }
  return ids;
}

function normalizePortableSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug || 'imported_binding';
}

function ensureUniqueSlug(baseSlug: string, usedSlugs: Set<string>): string {
  let slug = baseSlug;
  let suffix = 2;
  while (usedSlugs.has(slug)) {
    const suffixText = `_${suffix}`;
    slug = `${baseSlug.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  usedSlugs.add(slug);
  return slug;
}

function collectImportedSearchIndexSlugs(records: StagedRecord[]): Set<string> {
  const slugs = new Set<string>();
  for (const record of records) {
    if (record.collection !== 'search_indexes') {
      continue;
    }
    const slug = record.data.slug;
    if (typeof slug === 'string' && slug.length > 0) {
      slugs.add(slug);
    }
  }
  return slugs;
}

function synthesizeUnfulfilledSearchBindingRecords(input: {
  records: StagedRecord[];
  exportedIndexId: string;
  kbName: string;
  options: Pick<ImportOptionsV2, 'tenantId' | 'projectId' | 'userId'>;
  usedSlugs: Set<string>;
}): void {
  const slug = ensureUniqueSlug(normalizePortableSlug(input.kbName), input.usedSlugs);
  const collectionName = `search-vectors-imported-${slug}`;

  input.records.push({
    layer: 'search',
    collection: 'search_indexes',
    data: {
      _exportedId: input.exportedIndexId,
      slug,
      name: input.kbName,
      description:
        'Imported placeholder created because the archive referenced this knowledge base but did not include the search layer.',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
      vectorStore: {
        provider: 'qdrant',
        collectionName,
      },
      searchDefaults: {
        topK: 10,
        similarityThreshold: 0.2,
        includeMetadata: true,
        includeContent: true,
      },
      tenantId: input.options.tenantId,
      projectId: input.options.projectId,
      createdBy: input.options.userId,
    },
  });

  input.records.push({
    layer: 'search',
    collection: 'knowledge_bases',
    data: {
      name: input.kbName,
      description:
        'Imported placeholder created because the archive referenced this knowledge base but did not include the search layer.',
      _indexSlug: slug,
      connectorCount: 0,
      isPublic: false,
      tenantId: input.options.tenantId,
      projectId: input.options.projectId,
      createdBy: input.options.userId,
    },
  });
}

function collectImportedWorkflowExportedIds(records: StagedRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.collection !== 'workflows') {
      continue;
    }
    const exportedId = record.data._exportedId;
    if (typeof exportedId === 'string' && exportedId.length > 0) {
      ids.add(exportedId);
    }
  }
  return ids;
}

function collectWorkflowNameByExportedId(records: StagedRecord[]): Map<string, string> {
  const workflowNames = new Map<string, string>();
  for (const record of records) {
    if (record.collection !== 'workflows') {
      continue;
    }
    const exportedId = record.data._exportedId;
    const name = record.data.name;
    if (
      typeof exportedId === 'string' &&
      exportedId.length > 0 &&
      typeof name === 'string' &&
      name.length > 0
    ) {
      workflowNames.set(exportedId, name);
    }
  }
  return workflowNames;
}

function collectImportedTriggerRegistrationExportedIds(records: StagedRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.collection !== 'trigger_registrations') {
      continue;
    }
    const exportedId = record.data._exportedId;
    if (typeof exportedId === 'string' && exportedId.length > 0) {
      ids.add(exportedId);
    }
  }
  return ids;
}

function synthesizeUnfulfilledWorkflowTriggerRecord(input: {
  records: StagedRecord[];
  exportedTriggerId: string;
  workflowName: string;
  workflowVersion?: string;
  options: Pick<ImportOptionsV2, 'tenantId' | 'projectId' | 'userId'>;
}): void {
  input.records.push({
    layer: 'workflows',
    collection: 'trigger_registrations',
    data: {
      _exportedId: input.exportedTriggerId,
      _workflowName: input.workflowName,
      _workflowVersion: input.workflowVersion ?? 'draft',
      triggerName: `imported_${normalizePortableSlug(input.exportedTriggerId)}`,
      triggerType: 'webhook',
      status: 'active',
      config: {},
      authProfileId: null,
      tenantId: input.options.tenantId,
      projectId: input.options.projectId,
      createdBy: input.options.userId,
    },
  });
}

function persistNormalizedToolDsl(
  record: StagedRecord,
  normalization: ImportedToolDslNormalization,
): void {
  const { dslContent } = normalization;
  if (record.data.dslContent === dslContent) {
    if (normalization.searchAiIndexExportedId) {
      record.data._searchAiIndexExportedId = normalization.searchAiIndexExportedId;
    }
    if (normalization.workflowToolExportedWorkflowId) {
      record.data._workflowToolExportedWorkflowId = normalization.workflowToolExportedWorkflowId;
    }
    if (normalization.workflowToolExportedTriggerId) {
      record.data._workflowToolExportedTriggerId = normalization.workflowToolExportedTriggerId;
    }
    return;
  }

  record.data.dslContent = dslContent;
  record.data.sourceHash = computeSourceHash(dslContent);
  if (normalization.searchAiIndexExportedId) {
    record.data._searchAiIndexExportedId = normalization.searchAiIndexExportedId;
  }
  if (normalization.workflowToolExportedWorkflowId) {
    record.data._workflowToolExportedWorkflowId = normalization.workflowToolExportedWorkflowId;
  }
  if (normalization.workflowToolExportedTriggerId) {
    record.data._workflowToolExportedTriggerId = normalization.workflowToolExportedTriggerId;
  }
}

function importedWorkflowToolDiagnostic(message: string): string {
  return `${message}. Workflow tool bindings with source workflow_id/trigger_id are not portable unless the archive includes exported workflow and trigger metadata. Re-export the project after workflow trigger export support is available, or bind the tool to a workflow/trigger that already exists in the target project.`;
}

function bindingResolutionRequestId(input: {
  kind: ImportBindingResolutionRequest['kind'];
  toolName: string;
  source: ImportBindingResolutionRequest['source'];
}): string {
  return `binding_${makeIssueId(
    JSON.stringify({
      kind: input.kind,
      toolName: input.toolName,
      source: input.source,
    }),
  )}`;
}

function createBindingResolutionRequest(input: {
  toolName: string;
  toolType: 'searchai' | 'workflow';
  normalization: ImportedToolDslNormalization;
}): ImportBindingResolutionRequest | null {
  if (input.toolType === 'searchai' && input.normalization.searchAiIndexExportedId) {
    const source = {
      indexId: input.normalization.searchAiIndexExportedId,
      ...(input.normalization.searchAiTenantId
        ? { tenantId: input.normalization.searchAiTenantId }
        : {}),
      ...(input.normalization.searchAiKbName ? { kbName: input.normalization.searchAiKbName } : {}),
    };
    return {
      id: bindingResolutionRequestId({
        kind: 'searchai_index',
        toolName: input.toolName,
        source,
      }),
      kind: 'searchai_index',
      toolName: input.toolName,
      toolType: 'searchai',
      message: `SearchAI tool "${input.toolName}" references a source project knowledge base/index that does not exist in this project. Select an existing target knowledge base or create one before applying.`,
      required: true,
      supportedActions: ['map_existing'],
      source,
    };
  }

  if (
    input.toolType === 'workflow' &&
    input.normalization.workflowToolExportedWorkflowId &&
    input.normalization.workflowToolExportedTriggerId
  ) {
    const source = {
      workflowId: input.normalization.workflowToolExportedWorkflowId,
      triggerId: input.normalization.workflowToolExportedTriggerId,
      ...(input.normalization.workflowToolExportedVersion
        ? { workflowVersion: input.normalization.workflowToolExportedVersion }
        : {}),
    };
    return {
      id: bindingResolutionRequestId({
        kind: 'workflow_trigger',
        toolName: input.toolName,
        source,
      }),
      kind: 'workflow_trigger',
      toolName: input.toolName,
      toolType: 'workflow',
      message: `Workflow tool "${input.toolName}" references a source workflow/trigger that does not exist in this project. Select an existing target workflow trigger or import the workflow layer before applying.`,
      required: true,
      supportedActions: ['map_existing'],
      source,
    };
  }

  return null;
}

function applyBindingResolutionToDsl(input: {
  dslContent: string;
  request: ImportBindingResolutionRequest;
  resolution: ImportBindingResolutionInput;
  tenantId: string;
}): { success: true; dslContent: string } | { success: false; message: string } {
  if (input.resolution.action !== 'map_existing') {
    return {
      success: false,
      message: `Binding resolution "${input.request.id}" uses unsupported action "${input.resolution.action}"`,
    };
  }

  if (input.request.kind === 'searchai_index') {
    const indexId = input.resolution.target?.indexId;
    if (!indexId) {
      return {
        success: false,
        message: `Binding resolution "${input.request.id}" must include target.indexId`,
      };
    }
    return {
      success: true,
      dslContent: upsertIndentedDslProperty(
        upsertIndentedDslProperty(input.dslContent, 'tenant_id', input.tenantId),
        'index_id',
        indexId,
      ),
    };
  }

  const workflowId = input.resolution.target?.workflowId;
  const triggerId = input.resolution.target?.triggerId;
  if (!workflowId || !triggerId) {
    return {
      success: false,
      message: `Binding resolution "${input.request.id}" must include target.workflowId and target.triggerId`,
    };
  }

  let dslContent = upsertIndentedDslProperty(input.dslContent, 'workflow_id', workflowId);
  dslContent = upsertIndentedDslProperty(dslContent, 'trigger_id', triggerId);
  if (input.resolution.target?.workflowVersion) {
    dslContent = upsertIndentedDslProperty(
      dslContent,
      'workflow_version',
      input.resolution.target.workflowVersion,
    );
  }
  return { success: true, dslContent };
}

async function validateLayeredToolRecords(input: {
  records: StagedRecord[];
  options: ImportOptionsV2;
}): Promise<
  | {
      success: true;
      issues: Array<Omit<ImportIssue, 'id'>>;
      bindingResolutionRequests: ImportBindingResolutionRequest[];
    }
  | { success: false; message: string }
> {
  const importedSearchIndexExportedIds = collectImportedSearchIndexExportedIds(input.records);
  const importedSearchIndexSlugs = collectImportedSearchIndexSlugs(input.records);
  const importedWorkflowExportedIds = collectImportedWorkflowExportedIds(input.records);
  const workflowNameByExportedId = collectWorkflowNameByExportedId(input.records);
  const importedTriggerRegistrationExportedIds = collectImportedTriggerRegistrationExportedIds(
    input.records,
  );
  const issues: Array<Omit<ImportIssue, 'id'>> = [];
  const bindingResolutionRequests: ImportBindingResolutionRequest[] = [];

  for (const record of input.records) {
    if (record.collection !== 'project_tools') {
      continue;
    }

    const toolType = record.data.toolType;
    const dslContent = record.data.dslContent;
    const toolName = String(record.data.name ?? 'unknown');
    if (!isSupportedProjectToolType(toolType) || typeof dslContent !== 'string') {
      return {
        success: false,
        message: `Imported tool "${toolName}" is missing a supported toolType or dslContent`,
      };
    }

    const portableNormalization = normalizeImportedToolDslForTarget({
      toolType,
      dslContent,
      tenantId: input.options.tenantId,
    });
    const resolvesFromImportedSearchIndex =
      toolType === 'searchai' &&
      typeof portableNormalization.searchAiIndexExportedId === 'string' &&
      importedSearchIndexExportedIds.has(portableNormalization.searchAiIndexExportedId);
    const resolvesFromImportedWorkflow =
      toolType === 'workflow' &&
      typeof portableNormalization.workflowToolExportedWorkflowId === 'string' &&
      typeof portableNormalization.workflowToolExportedTriggerId === 'string' &&
      importedWorkflowExportedIds.has(portableNormalization.workflowToolExportedWorkflowId) &&
      importedTriggerRegistrationExportedIds.has(
        portableNormalization.workflowToolExportedTriggerId,
      );

    if (
      !input.options.validateToolBindingForSave ||
      resolvesFromImportedSearchIndex ||
      resolvesFromImportedWorkflow
    ) {
      persistNormalizedToolDsl(record, portableNormalization);
      continue;
    }

    const bindingResolutionToolType =
      toolType === 'searchai' || toolType === 'workflow' ? toolType : null;
    const request = bindingResolutionToolType
      ? createBindingResolutionRequest({
          toolName,
          toolType: bindingResolutionToolType,
          normalization: portableNormalization,
        })
      : null;
    const resolution = request ? input.options.bindingResolutions?.[request.id] : undefined;
    let dslContentForValidation = portableNormalization.dslContent;
    if (request && resolution) {
      const resolutionResult = applyBindingResolutionToDsl({
        dslContent: portableNormalization.dslContent,
        request,
        resolution,
        tenantId: input.options.tenantId,
      });
      if (!resolutionResult.success) {
        return { success: false, message: resolutionResult.message };
      }
      dslContentForValidation = resolutionResult.dslContent;
    }

    const validation = await input.options.validateToolBindingForSave({
      tenantId: input.options.tenantId,
      projectId: input.options.projectId,
      toolType,
      dslContent: dslContentForValidation,
    });

    if (!validation.valid) {
      if (
        toolType === 'searchai' &&
        !resolution &&
        typeof portableNormalization.searchAiIndexExportedId === 'string' &&
        typeof portableNormalization.searchAiKbName === 'string' &&
        portableNormalization.searchAiKbName.length > 0
      ) {
        synthesizeUnfulfilledSearchBindingRecords({
          records: input.records,
          exportedIndexId: portableNormalization.searchAiIndexExportedId,
          kbName: portableNormalization.searchAiKbName,
          options: input.options,
          usedSlugs: importedSearchIndexSlugs,
        });
        importedSearchIndexExportedIds.add(portableNormalization.searchAiIndexExportedId);
        persistNormalizedToolDsl(record, portableNormalization);
        continue;
      }

      if (
        toolType === 'workflow' &&
        !resolution &&
        typeof portableNormalization.workflowToolExportedWorkflowId === 'string' &&
        typeof portableNormalization.workflowToolExportedTriggerId === 'string' &&
        importedWorkflowExportedIds.has(portableNormalization.workflowToolExportedWorkflowId)
      ) {
        const workflowName = workflowNameByExportedId.get(
          portableNormalization.workflowToolExportedWorkflowId,
        );
        if (workflowName) {
          synthesizeUnfulfilledWorkflowTriggerRecord({
            records: input.records,
            exportedTriggerId: portableNormalization.workflowToolExportedTriggerId,
            workflowName,
            workflowVersion: portableNormalization.workflowToolExportedVersion,
            options: input.options,
          });
          importedTriggerRegistrationExportedIds.add(
            portableNormalization.workflowToolExportedTriggerId,
          );
          persistNormalizedToolDsl(record, portableNormalization);
          continue;
        }
      }

      const validationRequest =
        request ??
        (bindingResolutionToolType
          ? createBindingResolutionRequest({
              toolName,
              toolType: bindingResolutionToolType,
              normalization: portableNormalization,
            })
          : null);
      if (validationRequest && input.options.dryRun && !resolution) {
        bindingResolutionRequests.push(validationRequest);
        issues.push({
          severity: 'error',
          blocking: true,
          category: 'binding',
          code:
            validationRequest.kind === 'searchai_index'
              ? 'E_IMPORT_BINDING_SEARCHAI_INDEX'
              : 'E_IMPORT_BINDING_WORKFLOW_TRIGGER',
          message: validationRequest.message,
        });
        persistNormalizedToolDsl(record, portableNormalization);
        continue;
      }

      return {
        success: false,
        message: `Imported tool "${toolName}" is invalid: ${
          toolType === 'workflow'
            ? importedWorkflowToolDiagnostic(validation.message)
            : validation.message
        }`,
      };
    }

    persistNormalizedToolDsl(record, {
      ...portableNormalization,
      dslContent: validation.dslContent ?? dslContentForValidation,
    });
  }

  return { success: true, issues, bindingResolutionRequests };
}

async function validateLayeredRuntimeConfigRecords(input: {
  records: StagedRecord[];
  options: ImportOptionsV2;
}): Promise<{ success: true; records: StagedRecord[] } | { success: false; message: string }> {
  const canonicalized = canonicalizeRuntimeOperationTierOverrides(input.records);
  if (!canonicalized.success) {
    return { success: false, message: canonicalized.message };
  }

  const records: StagedRecord[] = [];

  for (const record of canonicalized.records) {
    if (record.collection === 'project_runtime_configs') {
      const portableData = stripRuntimeConfigSaveValidationMetadata(record.data);
      if (!input.options.validateRuntimeConfigForSave) {
        records.push({
          ...record,
          data: buildModelPolicyStagingData(record.data, portableData),
        });
        continue;
      }

      const validation = await input.options.validateRuntimeConfigForSave({
        tenantId: input.options.tenantId,
        projectId: input.options.projectId,
        data: portableData,
        sourceFile: recordSourceFile(record),
      });

      if (!validation.valid) {
        return {
          success: false,
          message: validation.message,
        };
      }

      records.push({
        ...record,
        data: buildValidatedRuntimeConfigStagingData(record.data, validation.data),
      });
      continue;
    }

    if (
      record.collection === 'project_llm_configs' ||
      record.collection === 'model_configs' ||
      record.collection === 'agent_model_configs'
    ) {
      const validation = validateProjectModelPolicyConfigWrite({
        data: stripModelPolicyImportMetadata(record.data),
      });
      if (!validation.valid) {
        return {
          success: false,
          message: validation.message,
        };
      }

      records.push({
        ...record,
        data: buildModelPolicyStagingData(record.data, validation.data),
      });
      continue;
    }

    records.push(record);
  }

  return { success: true, records };
}

function canonicalizeRuntimeOperationTierOverrides(
  records: StagedRecord[],
): { success: true; records: StagedRecord[] } | { success: false; message: string } {
  const runtimeRecord = records.find((record) => record.collection === 'project_runtime_configs');
  if (!runtimeRecord) {
    return { success: true, records };
  }

  const runtimePortable = stripRuntimeConfigSaveValidationMetadata(runtimeRecord.data);
  if (!hasOwnRecordKey(runtimePortable, 'operationTierOverrides')) {
    return { success: true, records };
  }

  const llmRecord = records.find((record) => record.collection === 'project_llm_configs');
  const llmPortable = llmRecord ? stripModelPolicyImportMetadata(llmRecord.data) : null;
  const runtimeFingerprint = stableConfigStringify(runtimePortable.operationTierOverrides ?? {});
  const llmFingerprint =
    llmPortable && hasOwnRecordKey(llmPortable, 'operationTierOverrides')
      ? stableConfigStringify(llmPortable.operationTierOverrides ?? {})
      : null;

  if (llmFingerprint !== null && llmFingerprint !== runtimeFingerprint) {
    return {
      success: false,
      message:
        'config/runtime-config.json and config/llm-config.json define conflicting operationTierOverrides; keep operation-tier overrides in config/llm-config.json or make both files match',
    };
  }

  const canonicalRecords = records.map((record) => {
    if (record !== runtimeRecord) {
      return record;
    }
    const nextData = { ...record.data };
    delete nextData.operationTierOverrides;
    return { ...record, data: nextData };
  });

  if (!llmRecord) {
    canonicalRecords.push({
      layer: runtimeRecord.layer,
      collection: 'project_llm_configs',
      data: buildModelPolicyStagingData(runtimeRecord.data, {
        operationTierOverrides: runtimePortable.operationTierOverrides,
      }),
    });
  }

  return { success: true, records: canonicalRecords };
}

function hasOwnRecordKey(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function stableConfigStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableConfigStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableConfigStringify(record[key])}`)
    .join(',')}}`;
}

function buildValidatedRuntimeConfigStagingData(
  recordData: Record<string, unknown>,
  validationData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return buildModelPolicyStagingData(
    recordData,
    validationData ?? stripRuntimeConfigSaveValidationMetadata(recordData),
  );
}

function buildModelPolicyStagingData(
  recordData: Record<string, unknown>,
  portableData: Record<string, unknown>,
): Record<string, unknown> {
  const ownership: Record<string, unknown> = {};

  for (const key of ['tenantId', 'projectId'] as const) {
    if (recordData[key] !== undefined && recordData[key] !== null) {
      ownership[key] = recordData[key];
    }
  }

  return {
    ...portableData,
    ...ownership,
  };
}

function buildErrorResult(code: string, message: string): ImportResultV2 {
  const issue: ImportIssue = {
    id: makeIssueId(JSON.stringify({ category: 'general', code, message, blocking: true })),
    severity: 'error',
    blocking: true,
    category: 'general',
    code,
    message,
  };

  return {
    success: false,
    operationId: '',
    phase: 'failed',
    preview: {
      valid: false,
      formatVersion: '2.0',
      layers: [],
      layerChanges: {},
      agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
      toolChanges: { added: [], modified: [], removed: [] },
      shaIntegrity: buildDefaultShaResult(),
      crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
      syntaxErrors: [],
      issues: [issue],
      hasBlockingIssues: true,
      requiresAcknowledgement: false,
      blockingIssueCount: 1,
      nonBlockingIssueCount: 0,
      entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
      warnings: [],
    },
    warnings: [],
    error: { code, message },
  };
}

function buildDefaultShaResult() {
  return {
    valid: true,
    integrityMatch: true,
    layerResults: {} as Record<string, { valid: boolean; mismatchedFiles: string[] }>,
    errors: [] as string[],
    warnings: [] as string[],
  };
}

/**
 * Build per-layer change summaries from folder read result.
 * For the core layer, computes actual diffs when existing state is available.
 * For other layers, reports file counts as "added".
 */
function buildLayerChanges(
  folderResult: FolderReadResultV2,
  importLayers: LayerName[],
  existingState: ExistingProjectStateV2,
  agentIdentity: ReturnType<typeof resolveImportedAgentIdentities>,
  toolExtraction: ReturnType<typeof extractToolsFromFiles>,
): ImportPreviewV2['layerChanges'] {
  const changes: ImportPreviewV2['layerChanges'] = {};

  // Compute core layer diffs if existing state is available
  const coreAgentDiffs = importLayers.includes('core')
    ? buildAgentChanges(agentIdentity, existingState)
    : undefined;
  const coreToolDiffs = importLayers.includes('core')
    ? buildToolChanges(toolExtraction, existingState)
    : undefined;
  const coreLocaleDiffs = importLayers.includes('core')
    ? buildLocaleChanges(folderResult, existingState)
    : undefined;
  const coreProfileDiffs = importLayers.includes('core')
    ? buildProfileChanges(folderResult, existingState)
    : undefined;
  const coreConfigDiffs = importLayers.includes('core')
    ? buildCoreConfigChanges(folderResult, existingState)
    : undefined;

  for (const layer of importLayers) {
    if (
      layer === 'core' &&
      coreAgentDiffs &&
      coreToolDiffs &&
      coreLocaleDiffs &&
      coreProfileDiffs &&
      coreConfigDiffs
    ) {
      changes[layer] = {
        added:
          coreAgentDiffs.added.length +
          coreToolDiffs.added.length +
          coreLocaleDiffs.added.length +
          coreProfileDiffs.added.length +
          coreConfigDiffs.added,
        modified:
          coreAgentDiffs.modified.length +
          coreToolDiffs.modified.length +
          coreLocaleDiffs.modified.length +
          coreProfileDiffs.modified.length +
          coreConfigDiffs.modified,
        removed:
          coreAgentDiffs.removed.length +
          coreToolDiffs.removed.length +
          coreLocaleDiffs.removed.length +
          coreProfileDiffs.removed.length,
        unchanged: coreAgentDiffs.unchanged.length + coreConfigDiffs.unchanged,
      };
    } else {
      const layerFileMap = folderResult.layerFiles[layer];
      const fileCount = layerFileMap ? layerFileMap.size : 0;
      changes[layer] = {
        added: fileCount,
        modified: 0,
        removed: 0,
        unchanged: 0,
      };
    }
  }

  return changes;
}

/**
 * Compute agent-level diffs between imported folder and existing state.
 * Uses the same diff algorithm as v1 for backward compatibility.
 */
function buildAgentChanges(
  agentIdentity: ReturnType<typeof resolveImportedAgentIdentities>,
  existingState: ExistingProjectStateV2,
): ImportPreviewV2['agentChanges'] {
  // Build imported agents map: name -> dslContent
  const importedAgents = new Map<string, string>();
  for (const [name, agent] of agentIdentity.agents) {
    importedAgents.set(name, agent.dslContent);
  }

  // Build existing agents DSL map
  const existingAgentsDsl = new Map<string, string>();
  for (const [name, agent] of existingState.agents) {
    if (agent.dslContent) {
      existingAgentsDsl.set(name, agent.dslContent);
    }
  }

  // Use the shared diff calculator
  const diffs = calculateImportDiffs(existingAgentsDsl, importedAgents);

  return {
    added: diffs.filter((d) => d.status === 'added').map((d) => d.name),
    modified: diffs
      .filter((d) => d.status === 'modified')
      .map((d) => ({ name: d.name, diff: d.diff! })),
    removed: diffs.filter((d) => d.status === 'removed').map((d) => d.name),
    unchanged: diffs.filter((d) => d.status === 'unchanged').map((d) => d.name),
  };
}

/**
 * Compute tool-level diffs between imported folder and existing state.
 */
function buildToolChanges(
  toolExtraction: ReturnType<typeof extractToolsFromFiles>,
  existingState: ExistingProjectStateV2,
): { added: string[]; modified: string[]; removed: string[] } {
  const existingTools =
    existingState.tools ?? new Map<string, { name: string; dslContent: string }>();

  const importedToolNames = new Set(toolExtraction.tools.map((t) => t.name));
  const existingToolNames = new Set(existingTools.keys());

  const added: string[] = [];
  const modified: string[] = [];

  for (const tool of toolExtraction.tools) {
    if (!existingToolNames.has(tool.name)) {
      added.push(tool.name);
    } else {
      const existing = existingTools.get(tool.name);
      if (existing && existing.dslContent !== tool.dslContent) {
        modified.push(tool.name);
      }
    }
  }

  const removed =
    toolExtraction.incompleteFiles.length > 0
      ? []
      : [...existingToolNames].filter((name) => !importedToolNames.has(name));

  return { added, modified, removed };
}

type CoreConfigChanges = {
  added: number;
  modified: number;
  unchanged: number;
};

function parseJsonObjectForPreview(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonArrayForPreview(content: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
        )
      : [];
  } catch {
    return [];
  }
}

function countSingletonConfigChange(
  folderResult: FolderReadResultV2,
  existingState: ExistingProjectStateV2,
  filePath: string,
  collection: string,
): CoreConfigChanges {
  if (!folderResult.configFiles.has(filePath)) {
    return { added: 0, modified: 0, unchanged: 0 };
  }

  const existing = existingState.activeRecords.get(collection) ?? [];
  if (existing.length === 0) {
    return { added: 1, modified: 0, unchanged: 0 };
  }

  const imported = parseJsonObjectForPreview(folderResult.configFiles.get(filePath) ?? '');
  return imported && previewRecordsEqual(imported, existing[0])
    ? { added: 0, modified: 0, unchanged: 1 }
    : { added: 0, modified: 1, unchanged: 0 };
}

function countNamedConfigChanges(input: {
  importedEntries: Iterable<Record<string, unknown>>;
  existingRecords: Array<{ _id: string; [key: string]: unknown }> | undefined;
  existingNameField: string;
  importedNameField?: string;
}): CoreConfigChanges {
  const existingByName = new Map<string, Record<string, unknown>>();
  for (const record of input.existingRecords ?? []) {
    const value = record[input.existingNameField];
    if (typeof value === 'string' && value.length > 0) {
      existingByName.set(value, record);
    }
  }

  const importedNameField = input.importedNameField ?? input.existingNameField;
  const importedByName = new Map<string, Record<string, unknown>>();
  for (const entry of input.importedEntries) {
    const value = entry[importedNameField];
    if (typeof value === 'string' && value.length > 0) {
      importedByName.set(value, entry);
    }
  }

  let added = 0;
  let modified = 0;
  let unchanged = 0;
  for (const [name, imported] of importedByName) {
    const existing = existingByName.get(name);
    if (!existing) {
      added++;
    } else if (previewRecordsEqual(imported, existing)) {
      unchanged++;
    } else {
      modified++;
    }
  }

  return { added, modified, unchanged };
}

function addConfigChanges(left: CoreConfigChanges, right: CoreConfigChanges): CoreConfigChanges {
  return {
    added: left.added + right.added,
    modified: left.modified + right.modified,
    unchanged: left.unchanged + right.unchanged,
  };
}

const PREVIEW_INTERNAL_FIELDS = new Set([
  '_id',
  '__v',
  '_v',
  'projectId',
  'tenantId',
  'createdBy',
  'createdAt',
  'updatedAt',
  '__ablImport',
]);

function normalizePreviewRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        !PREVIEW_INTERNAL_FIELDS.has(key) &&
        value !== undefined &&
        !(key === 'description' && value === null),
    ),
  );
}

function stablePreviewStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stablePreviewStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stablePreviewStringify(record[key])}`)
    .join(',')}}`;
}

function previewRecordsEqual(
  imported: Record<string, unknown>,
  existing: Record<string, unknown>,
): boolean {
  return (
    stablePreviewStringify(normalizePreviewRecord(imported)) ===
    stablePreviewStringify(normalizePreviewRecord(existing))
  );
}

function fileStem(filePath: string, suffix: string): string | null {
  const fileName = filePath.split('/').pop();
  return fileName?.endsWith(suffix) ? fileName.slice(0, -suffix.length) : null;
}

function normalizeEnvPreviewKey(key: unknown, environment: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0) {
    return null;
  }
  const normalizedEnvironment =
    typeof environment === 'string' && environment.length > 0 ? environment : 'global';
  return `${key}\u0000${normalizedEnvironment}`;
}

function buildCoreConfigChanges(
  folderResult: FolderReadResultV2,
  existingState: ExistingProjectStateV2,
): CoreConfigChanges {
  let changes: CoreConfigChanges = { added: 0, modified: 0, unchanged: 0 };

  for (const [filePath, collection] of [
    ['config/project-settings.json', 'project_settings'],
    ['config/runtime-config.json', 'project_runtime_configs'],
    ['config/llm-config.json', 'project_llm_configs'],
  ] as const) {
    changes = addConfigChanges(
      changes,
      countSingletonConfigChange(folderResult, existingState, filePath, collection),
    );
  }

  const projectModelConfigs: Record<string, unknown>[] = [];
  const agentModelConfigs: Record<string, unknown>[] = [];
  const mcpServerConfigs: Record<string, unknown>[] = [];

  for (const [filePath, content] of folderResult.configFiles) {
    if (/^config\/project-model-configs\/[^/]+\.model-config\.json$/.test(filePath)) {
      const parsed = parseJsonObjectForPreview(content);
      const name =
        typeof parsed?.name === 'string' ? parsed.name : fileStem(filePath, '.model-config.json');
      if (name && parsed) {
        projectModelConfigs.push({ ...parsed, name });
      }
      continue;
    }

    if (/^config\/agent-model-configs\/[^/]+\.model-config\.json$/.test(filePath)) {
      const parsed = parseJsonObjectForPreview(content);
      const agentName =
        typeof parsed?.agentName === 'string'
          ? parsed.agentName
          : fileStem(filePath, '.model-config.json');
      if (agentName && parsed) {
        agentModelConfigs.push({ ...parsed, agentName });
      }
      continue;
    }

    if (isMcpServerConfigFilePath(filePath)) {
      const parsed = parseJsonObjectForPreview(content);
      if (typeof parsed?.name === 'string') {
        mcpServerConfigs.push(parsed);
      }
    }
  }

  changes = addConfigChanges(
    changes,
    countNamedConfigChanges({
      importedEntries: projectModelConfigs,
      existingRecords: existingState.activeRecords.get('model_configs'),
      existingNameField: 'name',
    }),
  );
  changes = addConfigChanges(
    changes,
    countNamedConfigChanges({
      importedEntries: agentModelConfigs,
      existingRecords: existingState.activeRecords.get('agent_model_configs'),
      existingNameField: 'agentName',
    }),
  );
  changes = addConfigChanges(
    changes,
    countNamedConfigChanges({
      importedEntries: mcpServerConfigs,
      existingRecords: existingState.activeRecords.get('mcp_server_configs'),
      existingNameField: 'name',
    }),
  );

  const envEntries = parseJsonArrayForPreview(
    folderResult.environmentFiles.get('environment/env-vars.json') ?? '[]',
  );
  const importedEnvEntries: Record<string, unknown>[] = [];
  for (const entry of envEntries) {
    const key = normalizeEnvPreviewKey(entry.key, entry.environment);
    if (!key) {
      continue;
    }
    importedEnvEntries.push({
      ...entry,
      key,
      environment:
        typeof entry.environment === 'string' && entry.environment.length > 0
          ? entry.environment
          : 'global',
      isSecret: typeof entry.isSecret === 'boolean' ? entry.isSecret : false,
    });
  }
  const existingEnvRecords = existingState.activeRecords.get('environment_variables') ?? [];
  const existingEnvEntries: Array<{ _id: string; [key: string]: unknown }> = [];
  for (const record of existingEnvRecords) {
    const key = normalizeEnvPreviewKey(record.key, record.environment);
    if (!key) {
      continue;
    }
    existingEnvEntries.push({
      ...record,
      key,
      environment:
        typeof record.environment === 'string' && record.environment.length > 0
          ? record.environment
          : 'global',
      isSecret: typeof record.isSecret === 'boolean' ? record.isSecret : false,
    });
  }
  changes = addConfigChanges(
    changes,
    countNamedConfigChanges({
      importedEntries: importedEnvEntries,
      existingRecords: existingEnvEntries,
      existingNameField: 'key',
    }),
  );

  const configVarEntries = parseJsonArrayForPreview(
    folderResult.environmentFiles.get('environment/config-vars.json') ?? '[]',
  );
  changes = addConfigChanges(
    changes,
    countNamedConfigChanges({
      importedEntries: configVarEntries,
      existingRecords: existingState.activeRecords.get('project_config_variables'),
      existingNameField: 'key',
    }),
  );

  return changes;
}

function buildLocaleChanges(
  folderResult: FolderReadResultV2,
  existingState: ExistingProjectStateV2,
): NonNullable<ImportPreviewV2['localeChanges']> {
  const existingLocaleFiles = existingState.localeFiles ?? new Map<string, string>();

  const added: string[] = [];
  const modified: string[] = [];

  for (const [filePath, value] of folderResult.localeFiles) {
    if (!existingLocaleFiles.has(filePath)) {
      added.push(filePath);
    } else if (existingLocaleFiles.get(filePath) !== value) {
      modified.push(filePath);
    }
  }

  const removed = [...existingLocaleFiles.keys()].filter(
    (filePath) => !folderResult.localeFiles.has(filePath),
  );

  return { added, modified, removed };
}

function buildProfileChanges(
  folderResult: FolderReadResultV2,
  existingState: ExistingProjectStateV2,
): NonNullable<ImportPreviewV2['profileChanges']> {
  const existingProfiles = existingState.profileFiles ?? new Map<string, string>();

  const added: string[] = [];
  const modified: string[] = [];

  for (const [filePath, value] of folderResult.profileFiles) {
    if (!existingProfiles.has(filePath)) {
      added.push(filePath);
    } else if (existingProfiles.get(filePath) !== value) {
      modified.push(filePath);
    }
  }

  const removed = [...existingProfiles.keys()].filter(
    (filePath) => !folderResult.profileFiles.has(filePath),
  );

  return { added, modified, removed };
}

function makeIssueId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function pushIssue(issues: ImportIssue[], issue: Omit<ImportIssue, 'id'>): void {
  issues.push({
    ...issue,
    id: makeIssueId(
      JSON.stringify({
        category: issue.category,
        message: issue.message,
        file: issue.file,
        line: issue.line,
        agent: issue.agent,
        code: issue.code,
        blocking: issue.blocking,
      }),
    ),
  });
}

function refreshPreviewIssueCounts(preview: ImportPreviewV2): void {
  const blockingIssueCount = preview.issues.filter((issue) => issue.blocking).length;
  preview.blockingIssueCount = blockingIssueCount;
  preview.nonBlockingIssueCount = preview.issues.length - blockingIssueCount;
  preview.hasBlockingIssues = blockingIssueCount > 0;
  preview.valid = !preview.hasBlockingIssues;
  preview.requiresAcknowledgement = preview.nonBlockingIssueCount > 0;
}

function buildImportIssues(input: {
  syntaxErrors: Array<{ file: string; errors: Array<{ line: number; message: string }> }>;
  crossLayerResult: ReturnType<typeof validateCrossLayerDeps>;
  shaResult: ReturnType<typeof buildDefaultShaResult>;
  toolExtraction: ReturnType<typeof extractToolsFromFiles>;
  agentIdentity: ReturnType<typeof resolveImportedAgentIdentities>;
}): ImportIssue[] {
  const issues: ImportIssue[] = [];

  for (const syntaxError of input.syntaxErrors) {
    for (const error of syntaxError.errors) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'syntax',
        code: 'E_IMPORT_AGENT_SYNTAX',
        file: syntaxError.file,
        line: error.line,
        message: error.message,
      });
    }
  }

  for (const missing of input.crossLayerResult.missingDependencies) {
    pushIssue(issues, {
      severity: 'error',
      blocking: true,
      category: 'dependency',
      code: 'E_IMPORT_MISSING_DEPENDENCY',
      file: missing.source,
      message: `${missing.sourceLayer} dependency "${missing.target}" (${missing.targetLayer}) is missing for ${missing.source}`,
    });
  }

  for (const warning of input.crossLayerResult.warnings) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'dependency',
      code: 'W_IMPORT_DEPENDENCY',
      message: warning,
    });
  }

  for (const error of input.shaResult.errors) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'integrity',
      code: 'W_IMPORT_SHA_INTEGRITY',
      message: error,
    });
  }

  for (const warning of input.shaResult.warnings) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'integrity',
      code: 'W_IMPORT_SHA_WARNING',
      message: warning,
    });
  }

  for (const error of input.toolExtraction.errors) {
    pushIssue(issues, {
      severity: 'error',
      blocking: false,
      category: 'tool',
      code: 'E_IMPORT_TOOL_PARSE',
      file: error.sourceFile,
      message: error.message,
    });
  }

  for (const warning of input.toolExtraction.warnings) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'tool',
      code: warning.code,
      file: warning.sourceFile,
      message: warning.message,
    });
  }

  if (input.toolExtraction.incompleteFiles.length > 0) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'tool',
      code: 'W_IMPORT_TOOL_DIFF_INCOMPLETE',
      message:
        'Tool removals are not shown because one or more imported tool files could not be parsed confidently',
    });
  }

  for (const error of input.agentIdentity.errors) {
    pushIssue(issues, {
      severity: 'error',
      blocking: true,
      category: 'identity',
      code: 'E_IMPORT_AGENT_IDENTITY',
      message: error,
    });
  }

  for (const warning of input.agentIdentity.warnings) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category:
        warning.includes('Entry agent') || warning.includes('entry agent')
          ? 'entry_agent'
          : 'identity',
      code: 'W_IMPORT_AGENT_IDENTITY',
      message: warning,
    });
  }

  return issues;
}

/**
 * Build per-layer entity counts for post-import validation.
 */
function buildLayerCounts(
  folderResult: FolderReadResultV2,
  importLayers: LayerName[],
): Record<string, { imported: number; skipped: number }> {
  const counts: Record<string, { imported: number; skipped: number }> = {};

  for (const layer of importLayers) {
    const layerFileMap = folderResult.layerFiles[layer];
    counts[layer] = {
      imported: layerFileMap ? layerFileMap.size : 0,
      skipped: 0,
    };
  }

  return counts;
}
