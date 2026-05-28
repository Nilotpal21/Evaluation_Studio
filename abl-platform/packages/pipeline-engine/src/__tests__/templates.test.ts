/**
 * Template conformance tests (ABLP-564 Phase 6).
 *
 * Asserts that every committed pipeline template:
 *   1. Loads from disk without error
 *   2. Passes validateGraphPipeline with the current ContractRegistry
 *   3. Has no unknown node types
 *
 * If a template fails these checks, CI blocks.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import { ContractRegistry } from '../pipeline/contracts/registry.js';
import { validateGraphPipeline } from '../pipeline/validation.js';
import { listTemplates, getTemplate } from '../pipeline/template-registry.js';
import { ACTIVITY_TYPES } from '../pipeline/activity-metadata.js';
import type {
  PipelineDefinition,
  TriggerEntry,
  PipelineNode,
  NodeTransition,
} from '../pipeline/types.js';

let registry: NodeRegistry;
const contracts = new ContractRegistry();

beforeAll(() => {
  registry = new NodeRegistry();
  for (const [type, meta] of Object.entries(ACTIVITY_TYPES)) {
    registry.register({
      type,
      category: 'compute',
      label: (meta as { name?: string }).name ?? type,
      description: (meta as { description?: string }).description ?? '',
      configSchema: { fields: [] },
      executionModel: 'async',
    });
  }
});

describe('pipeline templates — conformance', () => {
  it('index.json lists at least 3 templates including blank', async () => {
    const index = await listTemplates();
    expect(index.length).toBeGreaterThanOrEqual(3);
    const ids = index.map((t) => t.id);
    expect(ids).toContain('blank');
  });

  it('blank template loads without nodes', async () => {
    const def = await getTemplate('blank');
    expect(def).not.toBeNull();
    expect(def!.nodes).toHaveLength(0);
  });

  it('returns null for unknown template id', async () => {
    const def = await getTemplate('../../../../etc/passwd');
    expect(def).toBeNull();
  });

  // Test each non-blank template
  const nonBlankIds = ['quality-evaluator', 'llm-evaluator', 'per-message-guardrail'];

  for (const templateId of nonBlankIds) {
    it(`${templateId}: loads and passes validateGraphPipeline`, async () => {
      const def = await getTemplate(templateId);
      expect(def, `${templateId} failed to load`).not.toBeNull();

      const pipeline = {
        _id: `test-${templateId}`,
        tenantId: 'test-tenant',
        projectId: 'test-project',
        name: def!.name,
        version: 1,
        status: 'draft' as const,
        supportedTriggers: (def!.supportedTriggers ?? []) as TriggerEntry[],
        defaultTriggerIds: def!.defaultTriggerIds ?? [],
        nodes: (def!.nodes ?? []) as PipelineNode[],
        entryNodeId: def!.entryNodeId,
        configSchema: def!.configSchema ?? { fields: [] },
        createdBy: 'test',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as PipelineDefinition;

      const result = validateGraphPipeline(pipeline, registry, contracts);
      expect(result.errors, `${templateId} errors: ${JSON.stringify(result.errors)}`).toHaveLength(
        0,
      );
    });

    it(`${templateId}: all node types are known to ACTIVITY_TYPES`, async () => {
      const def = await getTemplate(templateId);
      if (!def) return;
      const nodes = def.nodes as Array<{ type: string }>;
      for (const node of nodes) {
        expect(
          node.type in ACTIVITY_TYPES,
          `Unknown node type "${node.type}" in template ${templateId}`,
        ).toBe(true);
      }
    });
  }
});
