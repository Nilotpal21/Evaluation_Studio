import { describe, it, expect, vi } from 'vitest';
import {
  buildModuleRelease,
  type ModuleReleaseInput,
  type CompileFn,
  type ExtractContractFn,
  type ValidatePublishSafetyFn,
} from '../module-release/build-module-release.js';
import type { ModuleReleaseContract } from '@agent-platform/database/models';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ModuleReleaseInput> = {}): ModuleReleaseInput {
  return {
    entryAgentName: 'main-agent',
    agents: { 'main-agent': 'AGENT: main-agent\nGOAL: do stuff' },
    tools: {},
    dslFormat: 'legacy',
    hasModelConfigs: false,
    ...overrides,
  };
}

function makeCompileFn(irOverrides: Record<string, unknown> = {}): CompileFn {
  return vi.fn().mockImplementation(() => ({
    metadata: { name: 'main-agent' },
    ...irOverrides,
  }));
}

function makeContract(): ModuleReleaseContract {
  return {
    providedAgents: [{ name: 'main-agent' }],
    providedTools: [],
    requiredConfigKeys: [],
    requiredEnvVars: [],
    requiredAuthProfiles: [],
    requiredConnectors: [],
    requiredMcpServers: [],
    warnings: [],
  };
}

function makeExtractContractFn(contract?: ModuleReleaseContract): ExtractContractFn {
  return vi.fn().mockReturnValue(contract ?? makeContract());
}

function makeSafetyFn(
  overrides: Partial<{
    safe: boolean;
    issues: Array<{
      severity: 'blocking' | 'warning';
      code: string;
      source: string;
      message: string;
    }>;
  }> = {},
): ValidatePublishSafetyFn {
  return vi.fn().mockReturnValue({ safe: true, issues: [], ...overrides });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('buildModuleRelease', () => {
  it('succeeds with a valid module project', () => {
    const compileFn = makeCompileFn();
    const contract = makeContract();
    const extractContractFn = makeExtractContractFn(contract);
    const safetyFn = makeSafetyFn();

    const result = buildModuleRelease(makeInput(), compileFn, extractContractFn, safetyFn);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.artifact.entryAgentName).toBe('main-agent');
    expect(result.artifact.dslFormat).toBe('legacy');
    expect(result.artifact.agents['main-agent']).toBeDefined();
    expect(result.artifact.agents['main-agent'].dslContent).toBe(
      'AGENT: main-agent\nGOAL: do stuff',
    );
    expect(result.artifact.agents['main-agent'].sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.contract).toBe(contract);
    expect(result.sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.warnings).toEqual([]);
  });

  it('carries standalone behavior profiles in the release artifact and contract inputs', () => {
    const compileFn = makeCompileFn({
      behavior_profiles: [{ name: 'voice_profile' }],
    });
    const extractContractFn = makeExtractContractFn({
      ...makeContract(),
      providedBehaviorProfiles: [{ name: 'voice_profile' }],
    });
    const safetyFn = makeSafetyFn();

    const result = buildModuleRelease(
      makeInput({
        profiles: {
          voice_profile: 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 10\nWHEN: true',
        },
      }),
      compileFn,
      extractContractFn,
      safetyFn,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.artifact.profiles?.voice_profile.dslContent).toContain(
      'BEHAVIOR_PROFILE: voice_profile',
    );
    expect(result.artifact.profiles?.voice_profile.sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(extractContractFn).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), [
      { name: 'voice_profile', dslContent: expect.stringContaining('BEHAVIOR_PROFILE') },
    ]);
    expect(safetyFn).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), [
      { name: 'voice_profile', dslContent: expect.stringContaining('BEHAVIOR_PROFILE') },
    ]);
  });

  it('fails when no agents are provided', () => {
    const result = buildModuleRelease(
      makeInput({ agents: {} }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toContain('Module must contain at least one agent');
  });

  it('fails when entryAgentName is null', () => {
    const result = buildModuleRelease(
      makeInput({ entryAgentName: null }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain('entry agent name');
  });

  it('fails when entryAgentName is empty string', () => {
    const result = buildModuleRelease(
      makeInput({ entryAgentName: '' }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain('entry agent name');
  });

  it('fails when entryAgentName does not match any agent', () => {
    const result = buildModuleRelease(
      makeInput({ entryAgentName: 'nonexistent-agent' }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain("Entry agent 'nonexistent-agent' not found");
    expect(result.errors[0]).toContain('main-agent');
  });

  it('fails when compile function returns null', () => {
    const compileFn = vi.fn().mockReturnValue(null) as CompileFn;

    const result = buildModuleRelease(
      makeInput(),
      compileFn,
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain("Agent 'main-agent' compilation failed");
  });

  it('fails when compile function throws an error', () => {
    const compileFn = vi.fn().mockImplementation(() => {
      throw new Error('Syntax error at line 5');
    }) as CompileFn;

    const result = buildModuleRelease(
      makeInput(),
      compileFn,
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain("Agent 'main-agent' compilation threw an error");
    expect(result.errors[0]).toContain('Syntax error at line 5');
  });

  it('fails when compile function throws a non-Error', () => {
    const compileFn = vi.fn().mockImplementation(() => {
      throw 'string error';
    }) as CompileFn;

    const result = buildModuleRelease(
      makeInput(),
      compileFn,
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain('string error');
  });

  it('fails when safety validation returns blocking issues', () => {
    const safetyFn = makeSafetyFn({
      safe: false,
      issues: [
        {
          severity: 'blocking',
          code: 'SECRET_LEAK',
          source: 'agent:main-agent',
          message: 'Credential leak detected in agent DSL',
        },
        {
          severity: 'warning',
          code: 'NON_PORTABLE',
          source: 'tool:my-tool',
          message: 'Consider removing debug flags',
        },
      ],
    });

    const result = buildModuleRelease(
      makeInput(),
      makeCompileFn(),
      makeExtractContractFn(),
      safetyFn,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]).toContain('Credential leak detected in agent DSL');
    expect(result.warnings[0]).toContain('Consider removing debug flags');
  });

  it('passes safety warnings through on success', () => {
    const safetyFn = makeSafetyFn({
      safe: true,
      issues: [
        {
          severity: 'warning',
          code: 'NON_PORTABLE',
          source: 'tool:my-tool',
          message: 'Non-portable binding detected',
        },
      ],
    });

    const result = buildModuleRelease(
      makeInput(),
      makeCompileFn(),
      makeExtractContractFn(),
      safetyFn,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.includes('Non-portable binding detected'))).toBe(true);
  });

  it('strips variable namespace IDs from compiled IR using both persisted and IR key shapes', () => {
    const compileFn = vi.fn().mockReturnValue({
      metadata: { name: 'main-agent' },
      tools: [
        {
          name: 'tool1',
          variableNamespaceIds: ['ns-123'],
          variable_namespace_ids: ['ns-ir-123'],
        },
        { name: 'tool2' },
      ],
      variableNamespaceIds: ['ns-456'],
      variable_namespace_ids: ['ns-ir-456'],
      nested: {
        deep: {
          variableNamespaceIds: ['ns-789'],
          variable_namespace_ids: ['ns-ir-789'],
          keep: true,
        },
      },
    }) as CompileFn;

    const result = buildModuleRelease(
      makeInput(),
      compileFn,
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    const ir = result.compiledIR['main-agent'];
    expect(ir).not.toHaveProperty('variableNamespaceIds');
    expect(ir).not.toHaveProperty('variable_namespace_ids');
    expect((ir.tools as any[])[0]).not.toHaveProperty('variableNamespaceIds');
    expect((ir.tools as any[])[0]).not.toHaveProperty('variable_namespace_ids');
    expect((ir.tools as any[])[1]).toEqual({ name: 'tool2' });
    expect((ir.nested as any).deep).not.toHaveProperty('variableNamespaceIds');
    expect((ir.nested as any).deep).not.toHaveProperty('variable_namespace_ids');
    expect((ir.nested as any).deep.keep).toBe(true);
  });

  it('produces the same sourceHash for the same inputs', () => {
    const input = makeInput();
    const r1 = buildModuleRelease(input, makeCompileFn(), makeExtractContractFn(), makeSafetyFn());
    const r2 = buildModuleRelease(input, makeCompileFn(), makeExtractContractFn(), makeSafetyFn());

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.sourceHash).toBe(r2.sourceHash);
  });

  it('produces different sourceHash for different DSL content', () => {
    const r1 = buildModuleRelease(
      makeInput(),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );
    const r2 = buildModuleRelease(
      makeInput({
        agents: { 'main-agent': 'AGENT: main-agent\nGOAL: different goal' },
      }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.sourceHash).not.toBe(r2.sourceHash);
  });

  it('produces different sourceHash for different entryAgentName', () => {
    const agents = {
      'agent-a': 'AGENT: agent-a\nGOAL: goal',
      'agent-b': 'AGENT: agent-b\nGOAL: goal',
    };
    const r1 = buildModuleRelease(
      makeInput({ agents, entryAgentName: 'agent-a' }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );
    const r2 = buildModuleRelease(
      makeInput({ agents, entryAgentName: 'agent-b' }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.sourceHash).not.toBe(r2.sourceHash);
  });

  it('packages agent companion metadata and uses precompiled IR when provided', () => {
    const compileFn = vi.fn(() => {
      throw new Error('compileFn should not be used when precompiled IR is supplied');
    }) as CompileFn;

    const result = buildModuleRelease(
      {
        ...makeInput(),
        agentCompanions: {
          'main-agent': {
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash',
            },
            resolvedSystemPrompt: 'Resolved prompt from library',
          },
        },
        precompiledIR: {
          'main-agent': {
            metadata: { name: 'main-agent' },
            identity: {
              system_prompt: {
                template: 'Resolved prompt from library',
                libraryRef: {
                  promptId: 'prompt-1',
                  versionId: 'version-1',
                  resolvedHash: 'prompt-hash',
                },
              },
            },
            tools: [],
          },
        },
      } as ModuleReleaseInput,
      compileFn,
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(compileFn).not.toHaveBeenCalled();
    expect(result.artifact.agents['main-agent']).toMatchObject({
      companion: {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'prompt-hash',
        },
        resolvedSystemPrompt: 'Resolved prompt from library',
      },
    });
    expect(result.compiledIR['main-agent']).toMatchObject({
      identity: {
        system_prompt: {
          template: 'Resolved prompt from library',
          libraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
            resolvedHash: 'prompt-hash',
          },
        },
      },
    });
  });

  it('produces different sourceHash when agent companion metadata changes', () => {
    const baseInput = {
      ...makeInput(),
      agentCompanions: {
        'main-agent': {
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
            resolvedHash: 'prompt-hash-1',
          },
          resolvedSystemPrompt: 'Prompt variant one',
        },
      },
    } as ModuleReleaseInput;

    const r1 = buildModuleRelease(
      baseInput,
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );
    const r2 = buildModuleRelease(
      {
        ...baseInput,
        agentCompanions: {
          'main-agent': {
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-2',
              resolvedHash: 'prompt-hash-2',
            },
            resolvedSystemPrompt: 'Prompt variant two',
          },
        },
      } as ModuleReleaseInput,
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.sourceHash).not.toBe(r2.sourceHash);
    expect(r1.artifact.agents['main-agent'].sourceHash).not.toBe(
      r2.artifact.agents['main-agent'].sourceHash,
    );
  });

  it('includes per-agent sourceHash in artifact', () => {
    const agents = {
      'main-agent': 'AGENT: main-agent\nGOAL: primary',
      helper: 'AGENT: helper\nGOAL: assist',
    };
    const result = buildModuleRelease(
      makeInput({ agents }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.artifact.agents['main-agent'].sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.artifact.agents['helper'].sourceHash).toMatch(/^[a-f0-9]{16}$/);
    // Different DSL content → different per-agent hash
    expect(result.artifact.agents['main-agent'].sourceHash).not.toBe(
      result.artifact.agents['helper'].sourceHash,
    );
  });

  it('includes tool artifacts with executable definitions plus dslContent, toolType, and sourceHash', () => {
    const tools = {
      my_http_tool: {
        dslContent: [
          'my_http_tool(customer_id: string) -> object',
          '  type: http',
          '  endpoint: https://api.example.com/customers',
          '  method: POST',
          '  auth_profile: "{{config.CRM_AUTH_PROFILE}}"',
        ].join('\n'),
        toolType: 'http' as const,
      },
      my_mcp_tool: {
        dslContent: [
          'my_mcp_tool(query: string) -> object',
          '  type: mcp',
          '  server: support',
          '  tool: lookup_ticket',
        ].join('\n'),
        toolType: 'mcp' as const,
      },
      run_flow: {
        dslContent: [
          'run_flow(payload: object) -> object',
          '  type: workflow',
          '  workflow_id: wf-1',
          '  trigger_id: tr-1',
        ].join('\n'),
        toolType: 'workflow' as const,
      },
    };
    const result = buildModuleRelease(
      makeInput({ tools }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.artifact.tools.my_http_tool.dslContent).toContain('my_http_tool');
    expect(result.artifact.tools.my_http_tool.toolType).toBe('http');
    expect(result.artifact.tools.my_http_tool.sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.artifact.tools.my_http_tool.definition).toEqual(
      expect.objectContaining({
        name: 'my_http_tool',
        tool_type: 'http',
        auth_profile_ref: '{{config.CRM_AUTH_PROFILE}}',
        http_binding: expect.objectContaining({
          endpoint: 'https://api.example.com/customers',
          method: 'POST',
        }),
      }),
    );
    expect(result.artifact.tools.my_mcp_tool.toolType).toBe('mcp');
    expect(result.artifact.tools.my_mcp_tool.definition).toEqual(
      expect.objectContaining({
        name: 'my_mcp_tool',
        tool_type: 'mcp',
        mcp_binding: expect.objectContaining({
          server: 'support',
          tool: 'lookup_ticket',
        }),
      }),
    );
    expect(result.artifact.tools.run_flow.toolType).toBe('workflow');
    expect(result.artifact.tools.run_flow.dslContent).toContain('workflow_id: wf-1');
    expect(result.artifact.tools.run_flow.definition).toEqual(
      expect.objectContaining({
        name: 'run_flow',
        tool_type: 'workflow',
        workflow_binding: expect.objectContaining({
          workflowId: 'wf-1',
          triggerId: 'tr-1',
        }),
      }),
    );
    // Different tool DSL → different hash
    expect(result.artifact.tools.my_http_tool.sourceHash).not.toBe(
      result.artifact.tools.my_mcp_tool.sourceHash,
    );
  });

  it('works with a clean safety validator', () => {
    const safetyFn = makeSafetyFn();
    const result = buildModuleRelease(
      makeInput(),
      makeCompileFn(),
      makeExtractContractFn(),
      safetyFn,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings).toEqual([]);
  });

  it('adds model config warning when hasModelConfigs is true', () => {
    const result = buildModuleRelease(
      makeInput({ hasModelConfigs: true }),
      makeCompileFn(),
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.includes('Model configuration'))).toBe(true);
  });

  it('calls extractContractFn with correct arguments including compiledIR and tool definitions', () => {
    const extractContractFn = makeExtractContractFn();
    const tools = {
      'my-tool': { dslContent: 'TOOL my-tool', toolType: 'http' as const },
    };
    const compileFn = makeCompileFn();
    buildModuleRelease(makeInput({ tools }), compileFn, extractContractFn, makeSafetyFn());

    expect(extractContractFn).toHaveBeenCalledWith(
      [
        {
          name: 'main-agent',
          dslContent: 'AGENT: main-agent\nGOAL: do stuff',
          compiledIR: expect.objectContaining({ metadata: { name: 'main-agent' } }),
        },
      ],
      [
        {
          name: 'my-tool',
          toolType: 'http',
          dslContent: 'TOOL my-tool',
          definition: expect.any(Object),
        },
      ],
      [],
    );
  });

  it('calls safety validator with correct arguments', () => {
    const safetyFn = makeSafetyFn();
    const input = makeInput();
    buildModuleRelease(input, makeCompileFn(), makeExtractContractFn(), safetyFn);

    expect(safetyFn).toHaveBeenCalledWith(
      [{ name: 'main-agent', dslContent: 'AGENT: main-agent\nGOAL: do stuff' }],
      expect.arrayContaining([]),
      [],
    );
  });

  it('reports all compile failures when multiple agents fail', () => {
    const compileFn = vi.fn().mockReturnValue(null) as CompileFn;
    const agents = {
      'main-agent': 'AGENT: main-agent',
      helper: 'AGENT: helper',
    };

    const result = buildModuleRelease(
      makeInput({ agents }),
      compileFn,
      makeExtractContractFn(),
      makeSafetyFn(),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('main-agent');
    expect(result.errors[1]).toContain('helper');
  });
});
