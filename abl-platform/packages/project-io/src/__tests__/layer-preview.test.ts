import { describe, expect, it, vi } from 'vitest';
import type { LayerAssembler, LayerQueryContext } from '../export/layer-assemblers/types.js';
import {
  buildDefaultAssemblerMap,
  buildLayerPreview,
  type ExportLayerPreviewEntry,
} from '../export/layer-preview.js';
import { buildExportProvisioningRequirements } from '../export/provisioning-preview.js';

function makeAssembler(count: number): LayerAssembler {
  return {
    assemble: vi.fn(async () => ({
      layer: 'core',
      files: new Map(),
      entityCount: count,
      warnings: [],
    })),
    countEntities: vi.fn(async () => count),
  };
}

const CTX: LayerQueryContext = {
  projectId: 'project-1',
  tenantId: 'tenant-1',
  dslFormat: 'source',
  guardrailFormat: 'json',
};

describe('buildDefaultAssemblerMap', () => {
  it('creates canonical assembler instances for the requested layers only', () => {
    const assemblers = buildDefaultAssemblerMap(['core', 'connections', 'prompts', 'workflows']);

    expect([...assemblers.keys()]).toEqual(['core', 'connections', 'prompts', 'workflows']);
    expect(assemblers.get('core')).toMatchObject({
      assemble: expect.any(Function),
      countEntities: expect.any(Function),
    });
    expect(assemblers.get('connections')).toMatchObject({
      assemble: expect.any(Function),
      countEntities: expect.any(Function),
    });
    expect(assemblers.get('prompts')).toMatchObject({
      assemble: expect.any(Function),
      countEntities: expect.any(Function),
    });
    expect(assemblers.has('evals')).toBe(false);
  });
});

describe('buildLayerPreview', () => {
  it('returns canonical layer entries with default modes and counts in layer order', async () => {
    const preview = await buildLayerPreview(
      CTX,
      new Map([
        ['connections', makeAssembler(3)],
        ['core', makeAssembler(11)],
        ['guardrails', makeAssembler(2)],
      ]),
      ['core', 'connections', 'guardrails'],
    );

    expect(preview).toEqual<ExportLayerPreviewEntry[]>([
      { name: 'core', defaultMode: 'always', entityCount: 11 },
      { name: 'connections', defaultMode: 'always', entityCount: 3 },
      { name: 'guardrails', defaultMode: 'on', entityCount: 2 },
    ]);
  });

  it('treats missing assemblers as zero-count layers instead of omitting them', async () => {
    const preview = await buildLayerPreview(
      CTX,
      new Map([
        ['core', makeAssembler(5)],
        ['workflows', makeAssembler(1)],
      ]),
      ['core', 'evals', 'prompts', 'workflows'],
    );

    expect(preview).toEqual<ExportLayerPreviewEntry[]>([
      { name: 'core', defaultMode: 'always', entityCount: 5 },
      { name: 'evals', defaultMode: 'off', entityCount: 0 },
      { name: 'prompts', defaultMode: 'on', entityCount: 0 },
      { name: 'workflows', defaultMode: 'on', entityCount: 1 },
    ]);
  });
});

describe('buildExportProvisioningRequirements', () => {
  it('deduplicates and sorts content-derived provisioning requirements', () => {
    const preview = buildExportProvisioningRequirements({
      agents: [
        {
          name: 'Support',
          dslContent:
            'AGENT: Support\nGOAL: Help\nPROMPT: {{env.OPENAI_API_KEY}} {{secrets.BILLING_SECRET}}\nAUTH: zendesk_oauth',
        },
      ],
      tools: [
        {
          dslContent:
            'TOOL: search_docs\nAUTH: auth_profile_ref docs_api\nCONNECTOR: salesforce\nMCP_SERVER: docs-mcp\nHEADERS:\n  X-Api-Key: {{env.OPENAI_API_KEY}}',
        },
        {
          name: 'billing_tool',
          dslContent: 'TOOL: billing_tool\nCONNECTOR: stripe\nMCP_SERVER: billing-mcp',
        },
      ],
      profiles: [
        {
          name: 'vip_support',
          dslContent:
            'BEHAVIOR_PROFILE: vip_support\nPRIORITY: 10\nWHEN: always\nPROMPT: {{env.VIP_SUPPORT_TOKEN}}',
        },
      ],
      connectorConfigs: [{ connectorType: 'unused-configured-connector' }],
      mcpServers: [{ name: 'unused-configured-mcp' }],
    });

    expect(preview).toEqual({
      requiredEnvVars: ['OPENAI_API_KEY', 'VIP_SUPPORT_TOKEN'],
      requiredAuthProfiles: [
        {
          authType: 'unknown',
          config: {},
          name: 'docs_api',
          referencedBy: ['tool:search_docs'],
          scope: 'project',
        },
        {
          authType: 'unknown',
          config: {},
          name: 'zendesk_oauth',
          referencedBy: ['Support'],
          scope: 'project',
        },
      ],
      requiredConnectors: ['salesforce', 'stripe', 'unused-configured-connector'],
      requiredMcpServers: ['billing-mcp', 'docs-mcp', 'unused-configured-mcp'],
    });
  });
});
