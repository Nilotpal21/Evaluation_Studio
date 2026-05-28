import { describe, expect, it } from 'vitest';
import {
  ALL_PORTABLE_PROJECT_LAYERS,
  EXPORT_ORCHESTRATOR_SCENARIO_COVERAGE,
  EXPORT_PLANNING_SCENARIO_COVERAGE,
  IMPORT_DEPENDENCY_SCENARIO_COVERAGE,
  IMPORT_EXPORT_E2E_BOUNDARY_SCENARIOS,
  IMPORT_COMPLETENESS_SCENARIO_COVERAGE,
  IMPORT_LOCKFILE_VALIDATION_SCENARIO_COVERAGE,
  IMPORT_MANIFEST_VALIDATION_SCENARIO_COVERAGE,
  IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE,
  IMPORT_SANITIZATION_SCENARIO_COVERAGE,
  IMPORT_SYNTAX_SCENARIO_COVERAGE,
  capturingAssembler,
  expectDeterministicLayerPlanning,
  makeFilesForLayers,
  makeExportOptions,
  runExportScenario,
  runActivationFailureScenario,
  runArchiveFileForUndeclaredLayerScenario,
  runArchivePortabilityHygieneScenario,
  runArchivePrefixNormalizationScenario,
  runBindingResolutionRoundTripScenario,
  runChannelUniqueCollisionUpsertScenario,
  runDuplicateEntityNamesScenario,
  runEmptyModelConfigUnfulfilledScenario,
  runFullArchiveCrossLayerImportScenario,
  runGuardrailScopedNameCollisionScenario,
  runInvalidBindingResolutionScenario,
  runIdempotentReimportPreviewScenario,
  runImportCompletenessScenario,
  runLayeredImportScenario,
  runLayerDeselectionWithDependenciesScenario,
  runLockfileLayerHashForUndeclaredLayerScenario,
  runLockfileSectionEmptyForManifestCountScenario,
  runMixedYamlLegacySyntaxScenario,
  runPartialLayerAgentScopedReferenceScenario,
  runPostImportProvisioningScenario,
  runRollbackAfterPartialActivationScenario,
  runSearchGraphCompleteRemappingScenario,
  runManifestLayerMissingLockfileHashScenario,
  runManifestLogicalEntityCountDiffersFromFileCountScenario,
  runSourceScopeScrubbingScenario,
  runToolConnectorReferenceWithoutConnectionsScenario,
  runUnknownManifestLayerScenario,
  runWorkflowVersionTriggerAmbiguityScenario,
  runLayerPlanningScenario,
} from './scenario-dsl.js';

describe('import/export expanded deterministic scenarios', () => {
  describe('Tier 1 - export layer planning invariants', () => {
    it(`${EXPORT_PLANNING_SCENARIO_COVERAGE.default_full_project} plans every portable project layer for default full-project export`, () => {
      const layers = runLayerPlanningScenario({});

      expect(layers).toEqual([...ALL_PORTABLE_PROJECT_LAYERS]);
      expectDeterministicLayerPlanning({});
    });

    it(`${EXPORT_PLANNING_SCENARIO_COVERAGE.explicit_layer_selection} preserves explicit user layer selection while retaining core`, () => {
      const layers = runLayerPlanningScenario({ requestedLayers: ['connections'] });

      expect(new Set(layers)).toEqual(new Set(['core', 'connections']));
      expectDeterministicLayerPlanning({ requestedLayers: ['connections'] });
    });

    it(`${EXPORT_PLANNING_SCENARIO_COVERAGE.portable_tool_dependency_expansion} expands portable tool dependency layers from core tools`, () => {
      const input = {
        requestedLayers: ['core'],
        tools: [
          {
            toolType: 'searchai',
            dslContent: 'search_docs(query: string) -> object\n  type: searchai\n',
          },
          {
            toolType: 'workflow',
            dslContent: 'process_loan(customer_id: string) -> object\n  type: workflow\n',
          },
        ],
      } as const;

      const layers = runLayerPlanningScenario(input);

      expect(layers).toEqual(expect.arrayContaining(['core', 'search', 'workflows']));
      expectDeterministicLayerPlanning(input);
    });

    it(`${EXPORT_PLANNING_SCENARIO_COVERAGE.canonical_requested_layer_order} returns requested layers in canonical dependency order`, () => {
      const layers = runLayerPlanningScenario({
        requestedLayers: ['workflows', 'connections'],
      });

      expect(layers).toEqual(['core', 'connections', 'workflows']);
    });

    it(`${EXPORT_PLANNING_SCENARIO_COVERAGE.tool_dependency_order_invariant} produces the same dependency layer order regardless of tool order`, () => {
      const searchTool = {
        toolType: 'searchai',
        dslContent: 'search_docs(query: string) -> object\n  type: searchai\n',
      };
      const workflowTool = {
        toolType: 'workflow',
        dslContent: 'process_loan(customer_id: string) -> object\n  type: workflow\n',
      };

      const searchFirst = runLayerPlanningScenario({
        requestedLayers: ['core'],
        tools: [searchTool, workflowTool],
      });
      const workflowFirst = runLayerPlanningScenario({
        requestedLayers: ['core'],
        tools: [workflowTool, searchTool],
      });

      expect(searchFirst).toEqual(workflowFirst);
      expect(searchFirst).toEqual(['core', 'workflows', 'search']);
    });
  });

  describe('Tier 2 - export orchestrator wiring sentinels', () => {
    it(`${EXPORT_ORCHESTRATOR_SCENARIO_COVERAGE.deployment_context_forwarding} forwards deployment export intent to layer assemblers`, async () => {
      const workflows = capturingAssembler('workflows');

      const result = await runExportScenario({
        options: makeExportOptions({
          layers: ['core', 'workflows'],
          includeDeployments: true,
        }),
        assemblers: [capturingAssembler('core'), workflows],
      });

      expect(result.success).toBe(true);
      expect(workflows.contexts).toHaveLength(1);
      expect(workflows.contexts[0]).toMatchObject({ includeDeployments: true });
    });

    it(`${EXPORT_ORCHESTRATOR_SCENARIO_COVERAGE.requested_layer_missing_assembler} fails closed when a requested portable layer has no assembler`, async () => {
      const result = await runExportScenario({
        options: makeExportOptions({ layers: ['core', 'guardrails'] }),
        assemblers: [capturingAssembler('core')],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'MISSING_LAYER_ASSEMBLER',
      });
    });
  });

  describe('Tier 1 - import manifest completeness invariants', () => {
    it(`${IMPORT_COMPLETENESS_SCENARIO_COVERAGE.manifest_declares_layer_without_files} rejects manifest-declared layers with no matching archive files`, () => {
      const result = runImportCompletenessScenario(['core', 'search']);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('search'),
          expect.stringContaining('declared'),
        ]),
      );
    });
  });

  describe('Tier 1 - import manifest validation invariants', () => {
    it(`${IMPORT_MANIFEST_VALIDATION_SCENARIO_COVERAGE.unknown_manifest_layer} rejects unknown manifest layer names before import planning`, () => {
      const result = runUnknownManifestLayerScenario();

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('quantum'),
          expect.stringContaining('layer'),
        ]),
      );
    });

    it(`${IMPORT_MANIFEST_VALIDATION_SCENARIO_COVERAGE.manifest_logical_entity_count_differs_from_file_count} accepts logical entity counts that differ from archive file counts`, () => {
      const result = runManifestLogicalEntityCountDiffersFromFileCountScenario();

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it(`${IMPORT_MANIFEST_VALIDATION_SCENARIO_COVERAGE.archive_file_for_undeclared_layer} rejects archive files for layers omitted from the manifest`, () => {
      const result = runArchiveFileForUndeclaredLayerScenario();

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('search'),
          expect.stringContaining('layers_included'),
        ]),
      );
    });

    it(`${IMPORT_MANIFEST_VALIDATION_SCENARIO_COVERAGE.duplicate_entity_names} rejects duplicate logical entity names within the same archive layer`, () => {
      const result = runDuplicateEntityNamesScenario();

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Duplicate Guardrail'),
          expect.stringContaining('duplicate'),
        ]),
      );
    });
  });

  describe('Tier 1 - import lockfile parity invariants', () => {
    it(`${IMPORT_LOCKFILE_VALIDATION_SCENARIO_COVERAGE.manifest_layer_missing_lockfile_hash} rejects manifest layers that do not have lockfile layer hashes`, () => {
      const result = runManifestLayerMissingLockfileHashScenario();

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('search'),
          expect.stringContaining('layer_hashes'),
        ]),
      );
    });

    it(`${IMPORT_LOCKFILE_VALIDATION_SCENARIO_COVERAGE.lockfile_layer_hash_for_undeclared_layer} rejects lockfile layer hashes for undeclared manifest layers`, () => {
      const result = runLockfileLayerHashForUndeclaredLayerScenario();

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('search'),
          expect.stringContaining('layers_included'),
        ]),
      );
    });

    it(`${IMPORT_LOCKFILE_VALIDATION_SCENARIO_COVERAGE.lockfile_section_empty_for_manifest_count} rejects non-zero manifest counts when the lockfile has no corresponding file entries`, () => {
      const result = runLockfileSectionEmptyForManifestCountScenario();

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('search'),
          expect.stringContaining('lockfile'),
        ]),
      );
    });
  });

  describe('Tier 1 - import cross-layer dependency invariants', () => {
    it(`${IMPORT_DEPENDENCY_SCENARIO_COVERAGE.tool_connector_reference_without_connections_layer} reports a tool connector reference even when the connections layer is absent`, () => {
      const result = runToolConnectorReferenceWithoutConnectionsScenario();

      expect(result.folder.success).toBe(true);
      expect(result.dependencyValidation.valid).toBe(false);
      expect(result.dependencyValidation.missingDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'account_api',
            target: 'mercury_core',
            targetLayer: 'connections',
            type: 'connector_import',
          }),
        ]),
      );
    });
  });

  describe('Tier 2 - import orchestrator wiring sentinels', () => {
    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.requested_layer_missing_files} fails when an explicitly requested layer has no archive files`, async () => {
      const result = await runLayeredImportScenario({
        files: makeFilesForLayers(['core'], ['core', 'search']),
        options: { layers: ['core', 'search'] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'REQUESTED_LAYER_MISSING_FILES',
      });
      expect(result.error?.message).toContain('search');
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.detected_layer_missing_disassembler} fails closed when a detected import layer has no disassembler`, async () => {
      const result = await runLayeredImportScenario({
        files: makeFilesForLayers(['workflows']),
        options: { layers: ['workflows'] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'MISSING_LAYER_DISASSEMBLER',
      });
      expect(result.error?.message).toContain('workflows');
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.activation_failure_preserves_details} preserves operation, layer, phase, and rollback status for activation failures`, async () => {
      const { result, dbAdapter } = await runActivationFailureScenario();

      expect(result.success).toBe(false);
      expect(result.operationId).toBe('operation-import-export-scenarios');
      expect(result.error).toMatchObject({
        code: 'ACTIVATION_FAILED',
      });
      expect(result.error?.message).toContain('activating/core');
      expect(result.error?.message).not.toBe('Import failed');
      expect(dbAdapter.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'activating' }),
          expect.objectContaining({ status: 'rolling_back' }),
          expect.objectContaining({ status: 'failed' }),
        ]),
      );
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.binding_resolution_round_trip} maps preview binding requests into target bindings without persisting stale source IDs`, async () => {
      const { preview, applied, persistedRecord } = await runBindingResolutionRoundTripScenario();

      expect(preview.success).toBe(true);
      expect(preview.preview.bindingResolutionRequests).toEqual([
        expect.objectContaining({
          kind: 'searchai_index',
          required: true,
          source: expect.objectContaining({ indexId: 'source-index-1' }),
        }),
      ]);
      expect(applied.success).toBe(true);
      expect(String(persistedRecord?.dslContent)).toContain('index_id: "target-index-1"');
      expect(String(persistedRecord?.dslContent)).toContain(
        'tenant_id: "tenant-import-export-scenarios"',
      );
      expect(String(persistedRecord?.dslContent)).not.toContain('source-index-1');
      expect(String(persistedRecord?.dslContent)).not.toContain('source-tenant-1');
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.full_archive_cross_layer_import} applies every portable layer with cross-layer references staged for remapping`, async () => {
      const { result, dbAdapter, crossRefDb } = await runFullArchiveCrossLayerImportScenario();

      expect(result.success).toBe(true);
      expect(result.preview.layers).toEqual(ALL_PORTABLE_PROJECT_LAYERS);
      expect(dbAdapter.inserted.map((entry) => entry.collection)).toEqual(
        expect.arrayContaining([
          'connector_connections',
          'project_agents',
          'project_tools',
          'search_indexes',
          'knowledge_bases',
          'search_sources',
          'workflows',
          'workflow_versions',
          'trigger_registrations',
          'guardrail_policies',
          'channel_connections',
          'webhook_subscriptions',
          'domain_vocabularies',
          'canonical_schemas',
          'eval_sets',
        ]),
      );
      expect(crossRefDb.updates.length).toBeGreaterThan(0);
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.workflow_version_trigger_ambiguity} keeps workflow tool resolution pinned to the exported trigger/version pair`, async () => {
      const result = await runWorkflowVersionTriggerAmbiguityScenario();

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(false);
      expect(result.preview.bindingResolutionRequests ?? []).toEqual([]);
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.layer_deselection_with_dependencies} blocks or resolves core-only imports when deselected layers are required by tools`, async () => {
      const result = await runLayerDeselectionWithDependenciesScenario();

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(true);
      expect(result.preview.bindingResolutionRequests).toEqual([
        expect.objectContaining({
          kind: 'searchai_index',
          toolName: 'search_docs',
        }),
      ]);
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.partial_layer_agent_scoped_reference} rejects partial layer imports whose agent-scoped references cannot resolve in the target project`, async () => {
      const result = await runPartialLayerAgentScopedReferenceScenario();

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(true);
      expect(result.preview.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blocking: true,
            category: 'dependency',
            message: expect.stringContaining('Main'),
          }),
        ]),
      );
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.empty_model_config_unfulfilled_state} imports runtime model references as target-scoped unresolved state instead of rejecting the archive`, async () => {
      const result = await runEmptyModelConfigUnfulfilledScenario();

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(false);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('unfulfilled model config')]),
      );
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.channel_unique_collision_upsert} supersedes existing channel connections instead of creating duplicate channel identity keys`, async () => {
      const { result, dbAdapter } = await runChannelUniqueCollisionUpsertScenario();

      expect(result.success).toBe(true);
      expect(dbAdapter.activated).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            collection: 'channel_connections',
            supersededIds: ['existing-channel-1'],
          }),
        ]),
      );
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.guardrail_scoped_name_collision} sanitizes scoped guardrail records without preserving source ownership`, () => {
      const result = runGuardrailScopedNameCollisionScenario();

      expect(result.valid).toBe(true);
      expect(result.sanitizedData).toMatchObject({
        name: 'Sensitive Data Policy',
        scope: expect.objectContaining({ type: 'agent' }),
      });
      expect(result.sanitizedData).not.toHaveProperty('_id');
      expect(result.sanitizedData).not.toHaveProperty('tenantId');
      expect(result.sanitizedData).not.toHaveProperty('projectId');
      expect(result.sanitizedData).not.toHaveProperty('createdBy');
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.search_graph_complete_remapping} remaps the search graph and vocabulary children without leaking source scope`, async () => {
      const { result, dbAdapter, crossRefDb } = await runSearchGraphCompleteRemappingScenario();

      expect(result.success).toBe(true);
      expect(crossRefDb.updates.map((entry) => entry.collection)).toEqual(
        expect.arrayContaining([
          'search_sources',
          'knowledge_bases',
          'domain_vocabularies',
          'canonical_schemas',
        ]),
      );
      const insertedRecords = dbAdapter.inserted.flatMap((entry) => entry.records);
      for (const record of insertedRecords) {
        expect(record.tenantId).toBe('tenant-import-export-scenarios');
        expect(record.projectId).toBe('project-import-export-scenarios');
      }
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.invalid_binding_resolution_rejected} rejects wrong-kind or incomplete binding resolution payloads before staging`, async () => {
      const { preview, applied } = await runInvalidBindingResolutionScenario();

      expect(preview.success).toBe(true);
      expect(preview.preview.bindingResolutionRequests).toHaveLength(1);
      expect(applied.success).toBe(false);
      expect(applied.error).toMatchObject({ code: 'TOOL_SAVE_VALIDATION_FAILED' });
      expect(applied.error?.message).toContain('target.indexId');
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.rollback_after_partial_activation} rolls back already activated layers when a later layer activation fails`, async () => {
      const { result, dbAdapter } = await runRollbackAfterPartialActivationScenario();

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'ACTIVATION_FAILED' });
      expect(dbAdapter.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'activating' }),
          expect.objectContaining({ status: 'rolling_back' }),
          expect.objectContaining({ status: 'failed' }),
        ]),
      );
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.archive_portability_hygiene} scans exported JSON files for source ownership and secret fields`, async () => {
      const { result, violations } = await runArchivePortabilityHygieneScenario();

      expect(result.success).toBe(true);
      expect(violations).toEqual([]);
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.post_import_action_required_warnings} reports provisioning work after a successful portable import`, async () => {
      const result = await runPostImportProvisioningScenario();

      expect(result.success).toBe(true);
      expect(result.postImportReport).toMatchObject({
        status: 'action_required',
        provisioning_required: {
          env_vars: ['MERCURY_API_KEY'],
          connectors_needing_credentials: ['mercury_core'],
          mcp_servers_needing_auth: ['mercury_banking_server'],
        },
      });
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.archive_prefix_normalization} treats root and single-directory wrapped archives equivalently`, async () => {
      const result = await runArchivePrefixNormalizationScenario();

      expect(result.success).toBe(true);
      expect(result.preview.layers).toEqual(['core']);
      expect(result.preview.entryAgentResolution).toMatchObject({
        requested: 'Main',
        resolved: 'Main',
      });
    });

    it(`${IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE.idempotent_reimport_preview} reports unchanged records when the same archive is imported again`, async () => {
      const result = await runIdempotentReimportPreviewScenario();

      expect(result.success).toBe(true);
      expect(result.preview.agentChanges.unchanged).toContain('Main');
      expect(result.preview.agentChanges.added).not.toContain('Main');
      expect(result.preview.agentChanges.modified).not.toContain('Main');
    });
  });

  describe('Tier 1 - import sanitization invariants', () => {
    it(`${IMPORT_SANITIZATION_SCENARIO_COVERAGE.source_scope_and_creator_fields_scrubbed} strips source tenant/project/user ownership fields from imported entities`, () => {
      const result = runSourceScopeScrubbingScenario();

      expect(result.valid).toBe(true);
      expect(result.sanitizedData).toMatchObject({
        connectorName: 'salesforce',
        displayName: 'Salesforce',
      });
      expect(result.sanitizedData).not.toHaveProperty('_id');
      expect(result.sanitizedData).not.toHaveProperty('tenantId');
      expect(result.sanitizedData).not.toHaveProperty('projectId');
      expect(result.sanitizedData).not.toHaveProperty('createdBy');
      expect(result.sanitizedData).not.toHaveProperty('ownerId');
    });
  });

  describe('Tier 1 - import syntax invariants', () => {
    it(`${IMPORT_SYNTAX_SCENARIO_COVERAGE.mixed_yaml_legacy_requires_canonical_parser} validates YAML object-form declarations through the canonical parser`, () => {
      const result = runMixedYamlLegacySyntaxScenario();

      expect(result.valid).toBe(true);
      expect(result.syntaxErrors).toEqual([]);
    });
  });

  describe('Tier 3 - E2E boundary scenario budget', () => {
    it('keeps the import/export E2E matrix focused on boundary behavior covered by deterministic scenarios', () => {
      expect(IMPORT_EXPORT_E2E_BOUNDARY_SCENARIOS).toHaveLength(6);

      for (const scenario of IMPORT_EXPORT_E2E_BOUNDARY_SCENARIOS) {
        expect(scenario.id).toMatch(/^E2E-IE-\d+$/);
        expect(scenario.deterministicCoveredBy.length).toBeGreaterThan(0);
        expect(scenario.maxDurationMs).toBeLessThanOrEqual(5000);
      }
    });
  });
});
