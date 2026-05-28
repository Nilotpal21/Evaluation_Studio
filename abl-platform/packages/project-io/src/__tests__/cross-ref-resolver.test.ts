/**
 * Tests for Cross-Reference Resolver — Phase 2.5 of the staged import pipeline.
 *
 * Verifies that foreign key resolution, array cross-references,
 * warning generation, and safety-net temp field cleanup all work correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveCrossReferences,
  CROSS_REF_RULES,
  ARRAY_CROSS_REF_RULES,
  type CrossRefDbAdapter,
} from '../import/cross-ref-resolver.js';
import { IMPORT_LIFECYCLE_FIELD } from '../import/staged-importer.js';

// ─── Mock DB Adapter ────────────────────────────────────────────────────

interface RecordedCall {
  collection: string;
  filter: Record<string, unknown>;
  projection?: Record<string, number>;
  operations?: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
  }>;
}

function isCleanupFilter(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.$and);
}

/**
 * Creates a mock CrossRefDbAdapter that returns configurable data per collection
 * and tracks all calls for assertion.
 */
function createMockDb(
  dataByQuery?: Map<string, Array<Record<string, unknown>>>,
): CrossRefDbAdapter & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  return {
    calls,

    queryStagedRecords: vi
      .fn()
      .mockImplementation(
        (
          collection: string,
          filter: Record<string, unknown>,
          projection: Record<string, number>,
        ): Promise<Array<Record<string, unknown>>> => {
          calls.push({ collection, filter, projection });

          if (!dataByQuery) return Promise.resolve([]);

          // Match based on collection name — callers set up data keyed by collection
          // Multiple queries to the same collection are distinguished by the filter
          for (const [key, data] of dataByQuery.entries()) {
            if (key === collection) {
              return Promise.resolve(data);
            }
            // Support composite keys like "collection:role" for disambiguation
            if (key.startsWith(`${collection}:`)) {
              const cleanup = isCleanupFilter(filter);
              if (key === `${collection}:cleanup` && cleanup) {
                return Promise.resolve(data);
              }
              if (key === `${collection}:dependent` && !cleanup) {
                // Check if this is a dependent query (has a temp join field in projection)
                const projKeys = Object.keys(projection);
                const hasTempField = projKeys.some((k) => k.startsWith('_'));
                if (hasTempField) {
                  return Promise.resolve(data);
                }
              }
            }
          }

          return Promise.resolve([]);
        },
      ),

    batchUpdateStagedRecords: vi.fn().mockImplementation(
      (
        collection: string,
        operations: Array<{
          filter: Record<string, unknown>;
          update: Record<string, unknown>;
        }>,
      ): Promise<void> => {
        calls.push({ collection, operations });
        return Promise.resolve();
      },
    ),
  };
}

/**
 * Simplified mock that uses a callback to decide what to return per query.
 */
function createCallbackMockDb(
  queryHandler: (
    collection: string,
    filter: Record<string, unknown>,
    projection: Record<string, number>,
  ) => Array<Record<string, unknown>>,
): CrossRefDbAdapter & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  return {
    calls,

    queryStagedRecords: vi
      .fn()
      .mockImplementation(
        (
          collection: string,
          filter: Record<string, unknown>,
          projection: Record<string, number>,
        ): Promise<Array<Record<string, unknown>>> => {
          calls.push({ collection, filter, projection });
          return Promise.resolve(queryHandler(collection, filter, projection));
        },
      ),

    batchUpdateStagedRecords: vi.fn().mockImplementation(
      (
        collection: string,
        operations: Array<{
          filter: Record<string, unknown>;
          update: Record<string, unknown>;
        }>,
      ): Promise<void> => {
        calls.push({ collection, operations });
        return Promise.resolve();
      },
    ),
  };
}

// ─── Test Data Constants ─────────────────────────────────────────────────

const OP_ID = 'op-test-1';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Cross-Reference Resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rule definitions ─────────────────────────────────────────────────

  describe('CROSS_REF_RULES', () => {
    it('should define 9 standard rules', () => {
      expect(CROSS_REF_RULES).toHaveLength(9);
    });

    it('should include workflows -> workflow_versions rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) => r.anchorCollection === 'workflows' && r.dependentCollection === 'workflow_versions',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('name');
      expect(rule!.tempJoinField).toBe('_workflowName');
      expect(rule!.targetForeignKey).toBe('workflowId');
    });

    it('should include search_indexes -> search_sources rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'search_indexes' && r.dependentCollection === 'search_sources',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('slug');
      expect(rule!.tempJoinField).toBe('_indexSlug');
      expect(rule!.targetForeignKey).toBe('indexId');
    });

    it('should include search_indexes -> knowledge_bases rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'search_indexes' && r.dependentCollection === 'knowledge_bases',
      );
      expect(rule).toBeDefined();
      expect(rule!.targetForeignKey).toBe('searchIndexId');
    });

    it('should include search_sources -> connector_configs exported-id rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'search_sources' && r.dependentCollection === 'connector_configs',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('_exportedId');
      expect(rule!.tempJoinField).toBe('_connectorConfigSourceId');
      expect(rule!.targetForeignKey).toBe('sourceId');
    });

    it('should include channel_connections -> webhook_subscriptions rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'channel_connections' &&
          r.dependentCollection === 'webhook_subscriptions',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('displayName');
      expect(rule!.tempJoinField).toBe('_channelDisplayName');
      expect(rule!.targetForeignKey).toBe('channelConnectionId');
    });

    it('should include project_agents -> channel_connections rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'project_agents' &&
          r.dependentCollection === 'channel_connections',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('name');
      expect(rule!.tempJoinField).toBe('_channelAgentName');
      expect(rule!.targetForeignKey).toBe('agentId');
    });

    it('should include project_agents -> guardrail_policies rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'project_agents' && r.dependentCollection === 'guardrail_policies',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('name');
      expect(rule!.tempJoinField).toBe('_guardrailAgentName');
      expect(rule!.targetForeignKey).toBe('scope.agentDefId');
    });

    it('should include knowledge_bases -> domain_vocabularies exported-id rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'knowledge_bases' &&
          r.dependentCollection === 'domain_vocabularies',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('_exportedId');
      expect(rule!.tempJoinField).toBe('_vocabularyKnowledgeBaseId');
      expect(rule!.targetForeignKey).toBe('projectKnowledgeBaseId');
    });

    it('should include knowledge_bases -> canonical_schemas exported-id rule', () => {
      const rule = CROSS_REF_RULES.find(
        (r) =>
          r.anchorCollection === 'knowledge_bases' && r.dependentCollection === 'canonical_schemas',
      );
      expect(rule).toBeDefined();
      expect(rule!.anchorMatchField).toBe('_exportedId');
      expect(rule!.tempJoinField).toBe('_schemaKnowledgeBaseId');
      expect(rule!.targetForeignKey).toBe('knowledgeBaseId');
    });
  });

  describe('ARRAY_CROSS_REF_RULES', () => {
    it('should define 3 array rules', () => {
      expect(ARRAY_CROSS_REF_RULES).toHaveLength(3);
    });

    it('should include eval_sets.scenarioIds rule with composite key', () => {
      const rule = ARRAY_CROSS_REF_RULES.find((r) => r.arrayField === 'scenarioIds');
      expect(rule).toBeDefined();
      expect(rule!.collection).toBe('eval_sets');
      expect(rule!.anchorCollection).toBe('eval_scenarios');
      expect(rule!.compositeKey).toBe(true);
      expect(rule!.anchorParentField).toBe('_parentSetName');
    });

    it('should include eval_sets.personaIds rule with composite key', () => {
      const rule = ARRAY_CROSS_REF_RULES.find((r) => r.arrayField === 'personaIds');
      expect(rule).toBeDefined();
      expect(rule!.collection).toBe('eval_sets');
      expect(rule!.anchorCollection).toBe('eval_personas');
      expect(rule!.compositeKey).toBe(true);
    });

    it('should include eval_sets.evaluatorIds rule without composite key', () => {
      const rule = ARRAY_CROSS_REF_RULES.find((r) => r.arrayField === 'evaluatorIds');
      expect(rule).toBeDefined();
      expect(rule!.collection).toBe('eval_sets');
      expect(rule!.anchorCollection).toBe('eval_evaluators');
      expect(rule!.anchorMatchField).toBe('name');
      expect(rule!.compositeKey).toBeUndefined();
    });
  });

  // ── resolveCrossReferences ───────────────────────────────────────────

  describe('resolveCrossReferences', () => {
    // ── Empty / missing input ────────────────────────────────────────

    describe('empty and missing input handling', () => {
      it('should handle undefined stagedRecordIds gracefully', async () => {
        const db = createMockDb();
        const result = await resolveCrossReferences(db, OP_ID, undefined);

        expect(result.resolved).toBe(0);
        expect(result.warnings).toEqual([]);
      });

      it('should handle empty stagedRecordIds object gracefully', async () => {
        const db = createMockDb();
        const result = await resolveCrossReferences(db, OP_ID, {});

        expect(result.resolved).toBe(0);
        expect(result.warnings).toEqual([]);
      });

      it('should handle empty arrays in stagedRecordIds', async () => {
        const db = createMockDb();
        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: [],
          workflow_versions: [],
        });

        expect(result.resolved).toBe(0);
        expect(result.warnings).toEqual([]);
      });
    });

    // ── No-op when collections not present ───────────────────────────

    describe('no-op for absent collections', () => {
      it('should skip rules when dependent collection has no staged records', async () => {
        const db = createCallbackMockDb((collection) => {
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'MyWorkflow' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          // No workflow_versions entry at all
        });

        expect(result.resolved).toBe(0);
        // batchUpdateStagedRecords should not be called for workflow_versions
        const updateCalls = db.calls.filter((c) => c.operations !== undefined);
        const wfvUpdates = updateCalls.filter((c) => c.collection === 'workflow_versions');
        expect(wfvUpdates).toHaveLength(0);
      });

      it('should skip anchor map building when anchor collection has no staged IDs', async () => {
        const db = createCallbackMockDb(() => []);

        const result = await resolveCrossReferences(db, OP_ID, {
          workflow_versions: ['wfv-1'],
          // No workflows entry
        });

        // Should produce a warning about no anchor records
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain('No anchor records found in "workflows"');
      });
    });

    // ── Standard cross-reference resolution ──────────────────────────

    describe('standard cross-reference resolution', () => {
      it('should resolve workflow name to workflowId on workflow_versions', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          // Safety-net cleanup queries use $and — return nothing for those
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [{ _id: 'wf-new-1', name: 'OrderProcessor' }];
          }
          if (collection === 'workflow_versions' && projection['_workflowName'] === 1) {
            return [{ _id: 'wfv-1', _workflowName: 'OrderProcessor' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-new-1'],
          workflow_versions: ['wfv-1'],
        });

        expect(result.resolved).toBe(1);
        // No warnings: resolution succeeded and safety net found nothing
        expect(result.warnings).toEqual([]);

        // Verify the batchUpdateStagedRecords call
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'workflow_versions',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations![0]).toEqual({
          filter: { _id: 'wfv-1' },
          update: {
            $set: { workflowId: 'wf-new-1' },
            $unset: { _workflowName: 1 },
          },
        });
      });

      it('should resolve search_indexes slug to indexId on search_sources', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'search_indexes') {
            return [{ _id: 'idx-1', slug: 'product-knowledge' }];
          }
          if (collection === 'search_sources' && projection['_indexSlug'] === 1) {
            return [{ _id: 'ss-1', _indexSlug: 'product-knowledge' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          search_indexes: ['idx-1'],
          search_sources: ['ss-1'],
        });

        expect(result.resolved).toBe(1);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'search_sources',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations![0].update).toEqual({
          $set: { indexId: 'idx-1' },
          $unset: { _indexSlug: 1 },
        });
      });

      it('should rewrite imported SearchAI tool DSL index_id to the staged target index id', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'search_indexes') {
            return [{ _id: 'idx-target-1', _exportedId: 'idx-source-1' }];
          }
          if (collection === 'project_tools' && projection._searchAiIndexExportedId === 1) {
            return [
              {
                _id: 'tool-1',
                _searchAiIndexExportedId: 'idx-source-1',
                dslContent: [
                  'search_docs(query: string) -> object',
                  '  type: searchai',
                  '  index_id: "idx-source-1"',
                  '  tenant_id: "tenant-target-1"',
                ].join('\n'),
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          search_indexes: ['idx-target-1'],
          project_tools: ['tool-1'],
        });

        expect(result.resolved).toBe(1);
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'project_tools',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations![0].update).toEqual({
          $set: {
            dslContent: [
              'search_docs(query: string) -> object',
              '  type: searchai',
              '  index_id: "idx-target-1"',
              '  tenant_id: "tenant-target-1"',
            ].join('\n'),
            sourceHash: expect.any(String),
          },
          $unset: { _searchAiIndexExportedId: 1 },
        });
      });

      it('should resolve workflow trigger registrations and rewrite workflow tool bindings', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [{ _id: 'wf-target-1', name: 'LoanFlow', _exportedId: 'wf-source-1' }];
          }
          if (collection === 'workflow_versions') {
            return [{ _id: 'wfv-target-1', workflowId: 'wf-target-1', version: 'draft' }];
          }
          if (
            collection === 'trigger_registrations' &&
            projection._workflowName === 1 &&
            projection._workflowVersion === 1
          ) {
            return [
              {
                _id: 'tr-target-1',
                _exportedId: 'tr-source-1',
                _workflowName: 'LoanFlow',
                _workflowVersion: 'draft',
              },
            ];
          }
          if (collection === 'project_tools' && projection._workflowToolExportedTriggerId === 1) {
            return [
              {
                _id: 'tool-1',
                _workflowToolExportedWorkflowId: 'wf-source-1',
                _workflowToolExportedTriggerId: 'tr-source-1',
                dslContent: [
                  'process_loan(customer_id: string) -> object',
                  '  type: workflow',
                  '  workflow_id: "wf-source-1"',
                  '  workflow_version: draft',
                  '  trigger_id: "tr-source-1"',
                ].join('\n'),
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-target-1'],
          workflow_versions: ['wfv-target-1'],
          trigger_registrations: ['tr-target-1'],
          project_tools: ['tool-1'],
        });

        expect(result.resolved).toBe(2);
        const triggerUpdates = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'trigger_registrations',
        );
        expect(triggerUpdates[0].operations![0].update).toEqual({
          $set: { workflowId: 'wf-target-1', workflowVersionId: 'wfv-target-1' },
          $unset: { _workflowName: 1, _workflowVersion: 1 },
        });

        const toolUpdates = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'project_tools',
        );
        expect(toolUpdates[0].operations![0].update).toEqual({
          $set: {
            dslContent: [
              'process_loan(customer_id: string) -> object',
              '  type: workflow',
              '  workflow_id: "wf-target-1"',
              '  workflow_version: draft',
              '  trigger_id: "tr-target-1"',
            ].join('\n'),
            sourceHash: expect.any(String),
          },
          $unset: {
            _workflowToolExportedWorkflowId: 1,
            _workflowToolExportedTriggerId: 1,
          },
        });
      });

      it('should resolve channel_connections displayName to channelConnectionId', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'channel_connections') {
            return [{ _id: 'cc-1', displayName: 'Slack Bot' }];
          }
          if (collection === 'webhook_subscriptions' && projection['_channelDisplayName'] === 1) {
            return [{ _id: 'ws-1', _channelDisplayName: 'Slack Bot' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          channel_connections: ['cc-1'],
          webhook_subscriptions: ['ws-1'],
        });

        expect(result.resolved).toBe(1);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'webhook_subscriptions',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations![0].update).toEqual({
          $set: { channelConnectionId: 'cc-1' },
          $unset: { _channelDisplayName: 1 },
        });
      });

      it('should resolve project_agents name to channel_connections agentId', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'project_agents') {
            return [{ _id: 'agent-1', name: 'SupportAgent' }];
          }
          if (collection === 'channel_connections' && projection['_channelAgentName'] === 1) {
            return [{ _id: 'cc-1', _channelAgentName: 'SupportAgent' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          project_agents: ['agent-1'],
          channel_connections: ['cc-1'],
        });

        expect(result.resolved).toBe(1);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'channel_connections',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations![0].update).toEqual({
          $set: { agentId: 'agent-1' },
          $unset: { _channelAgentName: 1 },
        });
      });

      it('should resolve project_agents name to guardrail scope.agentDefId', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'project_agents') {
            return [{ _id: 'agent-1', name: 'TransferAgent' }];
          }
          if (collection === 'guardrail_policies' && projection['_guardrailAgentName'] === 1) {
            return [{ _id: 'gp-1', _guardrailAgentName: 'TransferAgent' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          project_agents: ['agent-1'],
          guardrail_policies: ['gp-1'],
        });

        expect(result.resolved).toBe(1);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'guardrail_policies',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations![0].update).toEqual({
          $set: { 'scope.agentDefId': 'agent-1' },
          $unset: { _guardrailAgentName: 1 },
        });
      });
    });

    // ── Multiple standard rules in one pass ──────────────────────────

    describe('multiple standard rules in one pass', () => {
      it('should resolve all standard rules when all collections are present', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          // Anchor records
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'OrderFlow' }];
          }
          if (collection === 'search_indexes') {
            return [{ _id: 'idx-1', slug: 'docs-index' }];
          }
          if (collection === 'channel_connections' && projection.displayName === 1) {
            return [{ _id: 'cc-1', displayName: 'SlackChannel' }];
          }
          if (collection === 'project_agents') {
            return [{ _id: 'agent-1', name: 'TransferAgent' }];
          }

          // Dependent records
          if (collection === 'workflow_versions' && projection['_workflowName'] === 1) {
            return [{ _id: 'wfv-1', _workflowName: 'OrderFlow' }];
          }
          if (collection === 'search_sources' && projection['_indexSlug'] === 1) {
            return [{ _id: 'ss-1', _indexSlug: 'docs-index' }];
          }
          if (collection === 'knowledge_bases' && projection['_indexSlug'] === 1) {
            return [{ _id: 'kb-1', _indexSlug: 'docs-index' }];
          }
          if (collection === 'webhook_subscriptions' && projection['_channelDisplayName'] === 1) {
            return [{ _id: 'ws-1', _channelDisplayName: 'SlackChannel' }];
          }
          if (collection === 'channel_connections' && projection['_channelAgentName'] === 1) {
            return [{ _id: 'cc-1', _channelAgentName: 'TransferAgent' }];
          }
          if (collection === 'guardrail_policies' && projection['_guardrailAgentName'] === 1) {
            return [{ _id: 'gp-1', _guardrailAgentName: 'TransferAgent' }];
          }

          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          search_indexes: ['idx-1'],
          channel_connections: ['cc-1'],
          project_agents: ['agent-1'],
          workflow_versions: ['wfv-1'],
          search_sources: ['ss-1'],
          knowledge_bases: ['kb-1'],
          webhook_subscriptions: ['ws-1'],
          guardrail_policies: ['gp-1'],
        });

        expect(result.resolved).toBe(6);
        expect(result.warnings).toEqual([]);
      });

      it('should resolve multiple dependent records for the same anchor', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'SharedWorkflow' }];
          }
          if (collection === 'workflow_versions' && projection['_workflowName'] === 1) {
            return [
              { _id: 'wfv-1', _workflowName: 'SharedWorkflow' },
              { _id: 'wfv-2', _workflowName: 'SharedWorkflow' },
              { _id: 'wfv-3', _workflowName: 'SharedWorkflow' },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          workflow_versions: ['wfv-1', 'wfv-2', 'wfv-3'],
        });

        expect(result.resolved).toBe(3);
        expect(result.warnings).toEqual([]);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'workflow_versions',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations!).toHaveLength(3);
        // All three should set the same workflowId
        for (const op of updateCalls[0].operations!) {
          expect((op.update as Record<string, Record<string, string>>).$set.workflowId).toBe(
            'wf-1',
          );
        }
      });
    });

    // ── Unresolvable references produce warnings ─────────────────────

    describe('unresolvable references', () => {
      it('should warn but not fail when a dependent references a non-existent anchor', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'ExistingWorkflow' }];
          }
          if (collection === 'workflow_versions' && projection['_workflowName'] === 1) {
            return [
              { _id: 'wfv-1', _workflowName: 'ExistingWorkflow' },
              { _id: 'wfv-2', _workflowName: 'DeletedWorkflow' },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          workflow_versions: ['wfv-1', 'wfv-2'],
        });

        expect(result.resolved).toBe(1);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some((w) => w.includes('DeletedWorkflow'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('Cannot resolve workflowId'))).toBe(true);
      });

      it('should still strip temp field even for unresolved references', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return []; // No anchors at all
          }
          if (collection === 'workflow_versions' && projection['_workflowName'] === 1) {
            return [{ _id: 'wfv-1', _workflowName: 'GhostWorkflow' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-nonexistent'],
          workflow_versions: ['wfv-1'],
        });

        expect(result.resolved).toBe(0);
        // Should warn about no anchor records
        expect(result.warnings.some((w) => w.includes('No anchor records found'))).toBe(true);
      });

      it('should warn when anchor map is empty but dependents exist', async () => {
        const db = createCallbackMockDb(() => []);

        const result = await resolveCrossReferences(db, OP_ID, {
          search_indexes: ['idx-1'],
          search_sources: ['ss-1'],
        });

        // Warnings about no anchor records for search_sources and/or knowledge_bases
        const anchorWarnings = result.warnings.filter((w) => w.includes('No anchor records'));
        expect(anchorWarnings.length).toBeGreaterThan(0);
      });
    });

    // ── Mixed resolved/unresolved in same batch ──────────────────────

    describe('mixed resolved and unresolved in same batch', () => {
      it('should resolve some and warn about others in the same collection', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'search_indexes') {
            return [
              { _id: 'idx-1', slug: 'good-index' },
              { _id: 'idx-2', slug: 'another-index' },
            ];
          }
          if (collection === 'search_sources' && projection['_indexSlug'] === 1) {
            return [
              { _id: 'ss-1', _indexSlug: 'good-index' },
              { _id: 'ss-2', _indexSlug: 'missing-index' },
              { _id: 'ss-3', _indexSlug: 'another-index' },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          search_indexes: ['idx-1', 'idx-2'],
          search_sources: ['ss-1', 'ss-2', 'ss-3'],
        });

        expect(result.resolved).toBe(2); // good-index and another-index resolved
        // One warning for missing-index
        expect(result.warnings.some((w) => w.includes('missing-index'))).toBe(true);

        // Check that the batch update includes all 3 records
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'search_sources',
        );
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].operations!).toHaveLength(3);

        // Resolved records should have $set
        const resolvedOps = updateCalls[0].operations!.filter(
          (op) => (op.update as Record<string, unknown>).$set !== undefined,
        );
        expect(resolvedOps).toHaveLength(2);

        // Unresolved record should only have $unset
        const unresolvedOps = updateCalls[0].operations!.filter(
          (op) => (op.update as Record<string, unknown>).$set === undefined,
        );
        expect(unresolvedOps).toHaveLength(1);
        expect(unresolvedOps[0].filter).toEqual({ _id: 'ss-2' });
      });
    });

    // ── Array cross-reference resolution ─────────────────────────────

    describe('array cross-reference resolution', () => {
      it('should resolve scenarioIds using composite key (setName/scenarioName)', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'eval_scenarios') {
            return [
              { _id: 'scn-1', name: 'HappyPath', _parentSetName: 'MainSet' },
              { _id: 'scn-2', name: 'EdgeCase', _parentSetName: 'MainSet' },
            ];
          }
          if (collection === 'eval_sets' && projection['_nestedScenarioNames'] === 1) {
            return [
              {
                _id: 'es-1',
                name: 'MainSet',
                _nestedScenarioNames: ['HappyPath', 'EdgeCase'],
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          eval_scenarios: ['scn-1', 'scn-2'],
          eval_sets: ['es-1'],
        });

        expect(result.resolved).toBe(2);

        // Find the scenario-related batchUpdate call (the one that sets scenarioIds)
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'eval_sets',
        );
        // Two array rules both target eval_sets: scenarioIds and personaIds
        // Each rule produces a batchUpdate call when it finds staged records
        const scenarioUpdate = updateCalls.find((c) =>
          c.operations!.some(
            (op) =>
              (op.update as Record<string, Record<string, unknown>>).$set?.scenarioIds !==
              undefined,
          ),
        );
        expect(scenarioUpdate).toBeDefined();
        expect(scenarioUpdate!.operations![0].update).toEqual({
          $set: { scenarioIds: ['scn-1', 'scn-2'] },
          $unset: { _nestedScenarioNames: 1 },
        });
      });

      it('should resolve personaIds using composite key', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'eval_personas') {
            return [
              { _id: 'per-1', name: 'Friendly', _parentSetName: 'TestSet' },
              { _id: 'per-2', name: 'Aggressive', _parentSetName: 'TestSet' },
            ];
          }
          if (collection === 'eval_sets' && projection['_nestedPersonaNames'] === 1) {
            return [
              {
                _id: 'es-1',
                name: 'TestSet',
                _nestedPersonaNames: ['Friendly', 'Aggressive'],
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          eval_personas: ['per-1', 'per-2'],
          eval_sets: ['es-1'],
        });

        expect(result.resolved).toBe(2);

        // Find the persona-related batchUpdate call
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'eval_sets',
        );
        const personaUpdate = updateCalls.find((c) =>
          c.operations!.some(
            (op) =>
              (op.update as Record<string, Record<string, unknown>>).$set?.personaIds !== undefined,
          ),
        );
        expect(personaUpdate).toBeDefined();
        expect(personaUpdate!.operations![0].update).toEqual({
          $set: { personaIds: ['per-1', 'per-2'] },
          $unset: { _nestedPersonaNames: 1 },
        });
      });

      it('should handle partial resolution in array cross-refs', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'eval_scenarios') {
            return [{ _id: 'scn-1', name: 'Existing', _parentSetName: 'MySet' }];
          }
          if (collection === 'eval_sets' && projection['_nestedScenarioNames'] === 1) {
            return [
              {
                _id: 'es-1',
                name: 'MySet',
                _nestedScenarioNames: ['Existing', 'Missing', 'AlsoMissing'],
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          eval_scenarios: ['scn-1'],
          eval_sets: ['es-1'],
        });

        expect(result.resolved).toBe(1);
        // Two warnings for the missing scenarios
        const missingWarnings = result.warnings.filter((w) =>
          w.includes('Cannot resolve scenarioIds'),
        );
        expect(missingWarnings).toHaveLength(2);
        expect(result.warnings.some((w) => w.includes('"Missing"'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('"AlsoMissing"'))).toBe(true);

        // Find the scenario update call
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'eval_sets',
        );
        const scenarioUpdate = updateCalls.find((c) =>
          c.operations!.some(
            (op) =>
              (op.update as Record<string, Record<string, unknown>>).$set?.scenarioIds !==
              undefined,
          ),
        );
        expect(scenarioUpdate).toBeDefined();
        expect(scenarioUpdate!.operations![0].update).toEqual({
          $set: { scenarioIds: ['scn-1'] },
          $unset: { _nestedScenarioNames: 1 },
        });
      });

      it('should strip temp field when names array is empty', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'eval_sets' && projection['_nestedScenarioNames'] === 1) {
            return [
              {
                _id: 'es-1',
                name: 'EmptySet',
                _nestedScenarioNames: [],
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          eval_scenarios: [],
          eval_sets: ['es-1'],
        });

        expect(result.resolved).toBe(0);

        // Find the batchUpdate call that unsets _nestedScenarioNames
        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'eval_sets',
        );
        const scenarioUpdate = updateCalls.find((c) =>
          c.operations!.some(
            (op) =>
              (op.update as Record<string, Record<string, number>>).$unset?._nestedScenarioNames ===
              1,
          ),
        );
        expect(scenarioUpdate).toBeDefined();
        // Should unset the temp field even though the array was empty
        expect(scenarioUpdate!.operations![0].update).toEqual({
          $unset: { _nestedScenarioNames: 1 },
        });
      });

      it('should handle both scenarioIds and personaIds on the same eval set', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'eval_scenarios') {
            return [{ _id: 'scn-1', name: 'Scenario1', _parentSetName: 'FullSet' }];
          }
          if (collection === 'eval_personas') {
            return [{ _id: 'per-1', name: 'Persona1', _parentSetName: 'FullSet' }];
          }
          if (collection === 'eval_sets') {
            // Both queries for the eval_sets collection
            if (projection['_nestedScenarioNames'] === 1) {
              return [
                {
                  _id: 'es-1',
                  name: 'FullSet',
                  _nestedScenarioNames: ['Scenario1'],
                },
              ];
            }
            if (projection['_nestedPersonaNames'] === 1) {
              return [
                {
                  _id: 'es-1',
                  name: 'FullSet',
                  _nestedPersonaNames: ['Persona1'],
                },
              ];
            }
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          eval_scenarios: ['scn-1'],
          eval_personas: ['per-1'],
          eval_sets: ['es-1'],
        });

        expect(result.resolved).toBe(2);
        // Safety-net cleanup queries return [] so no safety-net warnings expected
        expect(result.warnings).toEqual([]);
      });
    });

    // ── Safety net: stripRemainingTempFields ─────────────────────────

    describe('safety net — stripRemainingTempFields', () => {
      it('should strip residual temp fields from staged records', async () => {
        let cleanupQueryCalled = false;

        const db = createCallbackMockDb((collection, filter) => {
          if (collection === 'workflows' && isCleanupFilter(filter)) {
            // Cleanup query: records still have temp fields
            cleanupQueryCalled = true;
            return [{ _id: 'wf-1', _exportedId: 'old-export-123' }];
          }
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'TestWF' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
        });

        expect(cleanupQueryCalled).toBe(true);
        // Should include a safety net warning
        expect(result.warnings.some((w) => w.includes('Safety net'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('workflows'))).toBe(true);

        // Should have called batchUpdateStagedRecords for cleanup
        const cleanupUpdates = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'workflows',
        );
        expect(cleanupUpdates.length).toBeGreaterThan(0);
        const lastUpdate = cleanupUpdates[cleanupUpdates.length - 1];
        expect(lastUpdate.operations![0].update).toEqual({
          $unset: { _exportedId: 1 },
        });
      });

      it('should not generate a warning when no residual temp fields remain', async () => {
        const db = createCallbackMockDb((collection, filter) => {
          if (isCleanupFilter(filter)) {
            // Cleanup query: no records have temp fields
            return [];
          }
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'CleanWF' }];
          }
          if (collection === 'workflow_versions') {
            return [{ _id: 'wfv-1', _workflowName: 'CleanWF' }];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          workflow_versions: ['wfv-1'],
        });

        const safetyNetWarnings = result.warnings.filter((w) => w.includes('Safety net'));
        expect(safetyNetWarnings).toHaveLength(0);
      });

      it('should strip multiple temp fields from a single record', async () => {
        const db = createCallbackMockDb((collection, filter) => {
          if (isCleanupFilter(filter)) {
            return [
              {
                _id: 'rec-1',
                _workflowName: 'leftover',
                _exportedId: 'old-id',
                _indexSlug: 'leftover-slug',
                _guardrailAgentName: 'TransferAgent',
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          some_collection: ['rec-1'],
        });

        expect(result.warnings.some((w) => w.includes('Safety net'))).toBe(true);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'some_collection',
        );
        expect(updateCalls).toHaveLength(1);
        const unsetFields = (
          updateCalls[0].operations![0].update as Record<string, Record<string, number>>
        ).$unset;
        expect(unsetFields).toEqual({
          _workflowName: 1,
          _exportedId: 1,
          _indexSlug: 1,
          _guardrailAgentName: 1,
        });
      });

      it('should handle errors in cleanup gracefully and add warning', async () => {
        const db = createCallbackMockDb((collection, filter) => {
          if (isCleanupFilter(filter)) {
            throw new Error('DB connection lost');
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          broken_collection: ['rec-1'],
        });

        // Should not throw, but should add a warning
        expect(result.warnings.some((w) => w.includes('Failed to strip temp fields'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('DB connection lost'))).toBe(true);
      });
    });

    // ── DB adapter call tracking ─────────────────────────────────────

    describe('database adapter call tracking', () => {
      it('should query anchor collections with correct filter and projection', async () => {
        const db = createCallbackMockDb(() => []);

        await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1', 'wf-2'],
        });

        // Find the non-cleanup query call for workflows.
        const queryCalls = db.calls.filter(
          (c) =>
            c.projection !== undefined &&
            c.collection === 'workflows' &&
            !isCleanupFilter(c.filter),
        );
        expect(queryCalls.length).toBeGreaterThan(0);

        const anchorQuery = queryCalls[0];
        expect(anchorQuery.filter).toEqual({
          _id: { $in: ['wf-1', 'wf-2'] },
          $or: [{ [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged' }, { status: 'staged' }],
        });
        expect(anchorQuery.projection).toHaveProperty('_id', 1);
        expect(anchorQuery.projection).toHaveProperty('name', 1);
      });

      it('should include composite key fields in anchor projection', async () => {
        const db = createCallbackMockDb(() => []);

        await resolveCrossReferences(db, OP_ID, {
          eval_scenarios: ['scn-1'],
          eval_sets: ['es-1'],
        });

        // Find the non-cleanup query call for eval_scenarios
        const queryCalls = db.calls.filter(
          (c) =>
            c.projection !== undefined &&
            c.collection === 'eval_scenarios' &&
            !isCleanupFilter(c.filter),
        );
        expect(queryCalls.length).toBeGreaterThan(0);

        const proj = queryCalls[0].projection!;
        expect(proj).toHaveProperty('_id', 1);
        expect(proj).toHaveProperty('name', 1);
        expect(proj).toHaveProperty('_parentSetName', 1);
      });

      it('should not call batchUpdateStagedRecords when there are no updates', async () => {
        const db = createCallbackMockDb((collection, filter) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'Test' }];
          }
          // Return no dependent records, so no updates needed
          return [];
        });

        await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          workflow_versions: ['wfv-1'],
        });

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'workflow_versions',
        );
        expect(updateCalls).toHaveLength(0);
      });
    });

    // ── Edge cases ───────────────────────────────────────────────────

    describe('edge cases', () => {
      it('should skip dependent records that lack the temp join field', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [{ _id: 'wf-1', name: 'TestWF' }];
          }
          if (collection === 'workflow_versions' && projection['_workflowName'] === 1) {
            return [
              { _id: 'wfv-1', _workflowName: 'TestWF' },
              { _id: 'wfv-2' }, // Missing _workflowName entirely
              { _id: 'wfv-3', _workflowName: 123 }, // Non-string value
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1'],
          workflow_versions: ['wfv-1', 'wfv-2', 'wfv-3'],
        });

        // Only the first one resolves
        expect(result.resolved).toBe(1);

        const updateCalls = db.calls.filter(
          (c) => c.operations !== undefined && c.collection === 'workflow_versions',
        );
        // The step-2 batchUpdate for workflow_versions
        expect(updateCalls).toHaveLength(1);
        // Only 1 update operation (the one with a valid string temp field)
        expect(updateCalls[0].operations!).toHaveLength(1);
      });

      it('should skip non-string entries in array cross-ref names', async () => {
        const db = createCallbackMockDb((collection, filter, projection) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'eval_scenarios') {
            return [{ _id: 'scn-1', name: 'ValidScenario', _parentSetName: 'Set1' }];
          }
          if (collection === 'eval_sets' && projection['_nestedScenarioNames'] === 1) {
            return [
              {
                _id: 'es-1',
                name: 'Set1',
                _nestedScenarioNames: ['ValidScenario', 42, null, 'ValidScenario'],
              },
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          eval_scenarios: ['scn-1'],
          eval_sets: ['es-1'],
        });

        // Both valid string entries of 'ValidScenario' resolve
        expect(result.resolved).toBe(2);
      });

      it('should handle anchor records with non-string match field values', async () => {
        const db = createCallbackMockDb((collection, filter) => {
          if (isCleanupFilter(filter)) return [];
          if (collection === 'workflows') {
            return [
              { _id: 'wf-1', name: 123 }, // Non-string name
              { _id: 'wf-2', name: null }, // Null name
              { _id: 'wf-3', name: 'ValidName' }, // Valid
            ];
          }
          return [];
        });

        const result = await resolveCrossReferences(db, OP_ID, {
          workflows: ['wf-1', 'wf-2', 'wf-3'],
        });

        // Should not throw; invalid anchors are simply ignored
        expect(result).toBeDefined();
      });
    });
  });
});
