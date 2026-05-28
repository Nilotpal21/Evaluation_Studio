import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agentFilePath,
  toolFilePath,
  buildFileMap,
  type AgentFileEntry,
} from '../export/folder-builder.js';
import {
  computeSourceHash,
  generateLockfile,
  verifyLockfileIntegrity,
  type LockfileAgentInput,
  type LockfileToolInput,
} from '../export/lockfile-generator.js';
import {
  generateManifest,
  generateManifestV2,
  type ManifestInput,
  type ManifestInputV2,
} from '../export/manifest-generator.js';
import { exportDeployments, type DeploymentRecord } from '../export/deployment-exporter.js';
import type { ToolFileEntry, DependencyEdge } from '../types.js';

// ─── Folder Builder ─────────────────────────────────────────────────────────

describe('folder-builder', () => {
  describe('agentFilePath', () => {
    it('should normalize agent names to lowercase with underscores', () => {
      expect(agentFilePath('MyAgent')).toBe('agents/myagent.agent.yaml');
    });

    it('should replace special characters with underscores', () => {
      expect(agentFilePath('My Agent!')).toBe('agents/my_agent_.agent.yaml');
    });

    it('should handle names with hyphens', () => {
      expect(agentFilePath('booking-agent')).toBe('agents/booking_agent.agent.yaml');
    });

    it('should handle names with numbers', () => {
      expect(agentFilePath('Agent123')).toBe('agents/agent123.agent.yaml');
    });

    it('should handle names that are already lowercase with underscores', () => {
      expect(agentFilePath('simple_agent')).toBe('agents/simple_agent.agent.yaml');
    });
  });

  describe('toolFilePath', () => {
    it('should normalize tool names to lowercase', () => {
      expect(toolFilePath('MyTool')).toBe('tools/mytool.tools.abl');
    });

    it('should preserve hyphens in tool names', () => {
      expect(toolFilePath('hotels-api')).toBe('tools/hotels-api.tools.abl');
    });

    it('should replace spaces and special characters', () => {
      expect(toolFilePath('My Tool!')).toBe('tools/my_tool_.tools.abl');
    });

    it('should handle tool names with underscores', () => {
      expect(toolFilePath('search_tool')).toBe('tools/search_tool.tools.abl');
    });
  });

  describe('buildFileMap', () => {
    it('should build a map with agents, tools, configs, and deployments', () => {
      const agents: AgentFileEntry[] = [
        { name: 'Main', dslContent: 'SUPERVISOR: Main', isSupervisor: true },
      ];
      const tools: ToolFileEntry[] = [{ name: 'hotels-api', content: 'TOOL: hotels-api' }];
      const configs = new Map([['models.json', '{}']]);
      const deployments = new Map([['dev.deployment.json', '{}']]);

      const result = buildFileMap(agents, tools, configs, deployments);

      expect(result.has('agents/main.agent.yaml')).toBe(true);
      expect(result.has('tools/hotels-api.tools.abl')).toBe(true);
      expect(result.has('config/models.json')).toBe(true);
      expect(result.has('deployments/dev.deployment.json')).toBe(true);
    });

    it('should handle agent name collisions with suffix', () => {
      // Two agents that normalize to the same path
      const agents: AgentFileEntry[] = [
        { name: 'my-agent', dslContent: 'AGENT: my-agent', isSupervisor: false },
        { name: 'my agent', dslContent: 'AGENT: my agent', isSupervisor: false },
      ];

      const result = buildFileMap(agents, [], new Map(), new Map());

      // Both should be in the map but with different paths
      expect(result.size).toBe(2);
      expect(result.has('agents/my_agent.agent.yaml')).toBe(true);
      expect(result.has('agents/my_agent_2.agent.yaml')).toBe(true);
    });

    it('should handle multiple agent name collisions with incrementing suffix', () => {
      const agents: AgentFileEntry[] = [
        { name: 'agent', dslContent: 'AGENT: agent1', isSupervisor: false },
        { name: 'Agent', dslContent: 'AGENT: agent2', isSupervisor: false },
        { name: 'AGENT', dslContent: 'AGENT: agent3', isSupervisor: false },
      ];

      const result = buildFileMap(agents, [], new Map(), new Map());

      expect(result.size).toBe(3);
      expect(result.has('agents/agent.agent.yaml')).toBe(true);
      expect(result.has('agents/agent_2.agent.yaml')).toBe(true);
      expect(result.has('agents/agent_3.agent.yaml')).toBe(true);
    });

    it('should return empty map for empty inputs', () => {
      const result = buildFileMap([], [], new Map(), new Map());
      expect(result.size).toBe(0);
    });

    it('should handle multiple config files', () => {
      const configs = new Map([
        ['models.json', '{"model": "gpt-4"}'],
        ['environment.json', '{"env": "dev"}'],
      ]);

      const result = buildFileMap([], [], configs, new Map());
      expect(result.has('config/models.json')).toBe(true);
      expect(result.has('config/environment.json')).toBe(true);
      expect(result.size).toBe(2);
    });
  });
});

// ─── Lockfile Generator ─────────────────────────────────────────────────────

describe('lockfile-generator', () => {
  describe('computeSourceHash', () => {
    it('should return a 16-character hex string', () => {
      const hash = computeSourceHash('hello world');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should produce consistent hashes for the same content', () => {
      const hash1 = computeSourceHash('test content');
      const hash2 = computeSourceHash('test content');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = computeSourceHash('content A');
      const hash2 = computeSourceHash('content B');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = computeSourceHash('');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should handle unicode content', () => {
      const hash = computeSourceHash('hello \u{1F600} world');
      expect(hash).toHaveLength(16);
    });
  });

  describe('generateLockfile', () => {
    const agents: LockfileAgentInput[] = [
      { name: 'AgentA', version: '1.0', dslContent: 'AGENT: AgentA', status: 'active' },
      { name: 'AgentB', version: '2.0', dslContent: 'AGENT: AgentB', status: 'active' },
    ];
    const tools: LockfileToolInput[] = [{ name: 'tool-1', content: 'TOOL: tool-1' }];

    it('should generate a lockfile with version 1.0', () => {
      const lockfile = generateLockfile(agents, tools);
      expect(lockfile.lockfile_version).toBe('1.0');
    });

    it('should include generated_at timestamp', () => {
      const before = new Date().toISOString();
      const lockfile = generateLockfile(agents, tools);
      const after = new Date().toISOString();

      expect(lockfile.generated_at >= before).toBe(true);
      expect(lockfile.generated_at <= after).toBe(true);
    });

    it('should include agent records with source hashes', () => {
      const lockfile = generateLockfile(agents, tools);

      expect(lockfile.agents['AgentA']).toBeDefined();
      expect(lockfile.agents['AgentA'].version).toBe('1.0');
      expect(lockfile.agents['AgentA'].status).toBe('active');
      expect(lockfile.agents['AgentA'].source_hash).toHaveLength(16);

      expect(lockfile.agents['AgentB']).toBeDefined();
      expect(lockfile.agents['AgentB'].version).toBe('2.0');
    });

    it('should include tool records with source hashes', () => {
      const lockfile = generateLockfile(agents, tools);

      expect(lockfile.tools['tool-1']).toBeDefined();
      expect(lockfile.tools['tool-1'].source_hash).toHaveLength(16);
    });

    it('should keep agent source_hash truncated while reflecting prompt companion changes', () => {
      const baseAgent: LockfileAgentInput = {
        name: 'AgentA',
        version: '1.0',
        dslContent: 'AGENT: AgentA',
        status: 'active',
      };

      const withoutPromptRef = generateLockfile([baseAgent], []);
      const withPromptRef = generateLockfile(
        [
          {
            ...baseAgent,
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          },
        ],
        [],
      );

      expect(withoutPromptRef.agents['AgentA'].source_hash).toHaveLength(16);
      expect(withPromptRef.agents['AgentA'].source_hash).toHaveLength(16);
      expect(withPromptRef.agents['AgentA'].source_hash).not.toBe(
        withoutPromptRef.agents['AgentA'].source_hash,
      );
    });

    it('should compute integrity hash', () => {
      const lockfile = generateLockfile(agents, tools);

      expect(lockfile.integrity).toBeTruthy();
      expect(lockfile.integrity).toHaveLength(64); // Full SHA-256 hex
    });

    it('should produce deterministic integrity regardless of insertion order', () => {
      const agentsReversed = [...agents].reverse();
      const lockfile1 = generateLockfile(agents, tools);
      const lockfile2 = generateLockfile(agentsReversed, tools);

      // Integrity should be the same because keys are sorted
      expect(lockfile1.integrity).toBe(lockfile2.integrity);
    });

    it('should handle empty agents and tools', () => {
      const lockfile = generateLockfile([], []);

      expect(lockfile.agents).toEqual({});
      expect(lockfile.tools).toEqual({});
      expect(lockfile.integrity).toBeTruthy();
    });
  });

  describe('verifyLockfileIntegrity', () => {
    it('should return true for a valid lockfile', () => {
      const agents: LockfileAgentInput[] = [
        { name: 'Agent', version: '1.0', dslContent: 'AGENT: Agent', status: 'active' },
      ];
      const lockfile = generateLockfile(agents, []);

      expect(verifyLockfileIntegrity(lockfile)).toBe(true);
    });

    it('should return false if agents are tampered with', () => {
      const agents: LockfileAgentInput[] = [
        { name: 'Agent', version: '1.0', dslContent: 'AGENT: Agent', status: 'active' },
      ];
      const lockfile = generateLockfile(agents, []);

      // Tamper with agent version
      lockfile.agents['Agent'].version = '2.0';

      expect(verifyLockfileIntegrity(lockfile)).toBe(false);
    });

    it('should return false if tools are tampered with', () => {
      const tools: LockfileToolInput[] = [{ name: 'tool', content: 'TOOL: tool' }];
      const lockfile = generateLockfile([], tools);

      // Tamper with tool hash
      lockfile.tools['tool'].source_hash = 'tampered';

      expect(verifyLockfileIntegrity(lockfile)).toBe(false);
    });

    it('should return false if a new agent is added after generation', () => {
      const lockfile = generateLockfile([], []);

      lockfile.agents['NewAgent'] = {
        version: '1.0',
        source_hash: 'abc123',
        status: 'active',
      };

      expect(verifyLockfileIntegrity(lockfile)).toBe(false);
    });

    it('should verify integrity with sorted keys', () => {
      // Generate lockfile with agents in reverse alphabetical order
      const agents: LockfileAgentInput[] = [
        { name: 'Zebra', version: '1.0', dslContent: 'AGENT: Zebra', status: 'active' },
        { name: 'Alpha', version: '1.0', dslContent: 'AGENT: Alpha', status: 'active' },
      ];
      const lockfile = generateLockfile(agents, []);
      expect(verifyLockfileIntegrity(lockfile)).toBe(true);
    });
  });
});

// ─── Manifest Generator ─────────────────────────────────────────────────────

describe('manifest-generator', () => {
  describe('generateManifest', () => {
    function makeInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
      return {
        projectName: 'Test Project',
        projectSlug: 'test-project',
        projectDescription: 'A test project',
        exportedBy: 'user-1',
        entryAgent: 'Main',
        agents: [
          {
            name: 'Main',
            description: 'Supervisor agent',
            ownerId: 'user-1',
            ownerTeamId: 'team-1',
            version: '1.0',
          },
        ],
        tools: [],
        edges: [],
        ...overrides,
      };
    }

    it('should generate manifest with correct metadata', () => {
      const manifest = generateManifest(makeInput());

      expect(manifest.name).toBe('Test Project');
      expect(manifest.slug).toBe('test-project');
      expect(manifest.description).toBe('A test project');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.abl_version).toBe('1.0');
      expect(manifest.exported_by).toBe('user-1');
      expect(manifest.entry_agent).toBe('Main');
    });

    it('should include exported_at timestamp', () => {
      const before = new Date().toISOString();
      const manifest = generateManifest(makeInput());
      const after = new Date().toISOString();

      expect(manifest.exported_at >= before).toBe(true);
      expect(manifest.exported_at <= after).toBe(true);
    });

    it('should map agents with correct paths and metadata', () => {
      const manifest = generateManifest(makeInput());

      const agent = manifest.agents['Main'];
      expect(agent).toBeDefined();
      expect(agent.path).toBe('agents/main.agent.yaml');
      expect(agent.owner).toBe('user-1');
      expect(agent.ownerTeam).toBe('team-1');
      expect(agent.description).toBe('Supervisor agent');
      expect(agent.version).toBe('1.0');
    });

    it('should map tools with correct paths', () => {
      const input = makeInput({
        tools: [
          { name: 'hotels-api', ownerId: 'user-2' },
          { name: 'search-tool', ownerId: null },
        ],
      });

      const manifest = generateManifest(input);

      expect(manifest.tools['hotels-api']).toBeDefined();
      expect(manifest.tools['hotels-api'].path).toBe('tools/hotels-api.tools.abl');
      expect(manifest.tools['hotels-api'].owner).toBe('user-2');

      expect(manifest.tools['search-tool']).toBeDefined();
      expect(manifest.tools['search-tool'].owner).toBeNull();
    });

    it('should include handoff and delegate edges in agent_references', () => {
      const edges: DependencyEdge[] = [
        { from: 'Main', to: 'Worker', type: 'handoff' },
        { from: 'Main', to: 'Helper', type: 'delegate' },
      ];

      const manifest = generateManifest(makeInput({ edges }));

      expect(manifest.dependencies.agent_references).toHaveLength(2);
      expect(manifest.dependencies.agent_references[0]).toEqual({
        from: 'Main',
        to: 'Worker',
        type: 'handoff',
      });
      expect(manifest.dependencies.agent_references[1]).toEqual({
        from: 'Main',
        to: 'Helper',
        type: 'delegate',
      });
    });

    it('should include tool_import edges in tool_imports', () => {
      const edges: DependencyEdge[] = [
        {
          from: 'Worker',
          to: 'hotels-api',
          type: 'tool_import',
          sourcePath: 'tools/hotels-api.tools.abl',
          toolNames: ['search', 'book'],
        },
      ];

      const manifest = generateManifest(makeInput({ edges }));

      expect(manifest.dependencies.tool_imports).toHaveLength(1);
      expect(manifest.dependencies.tool_imports[0]).toEqual({
        agent: 'Worker',
        source: 'tools/hotels-api.tools.abl',
        tools: ['search', 'book'],
      });
    });

    it('should handle tool_import edge without toolNames', () => {
      const edges: DependencyEdge[] = [
        {
          from: 'Worker',
          to: 'hotels-api',
          type: 'tool_import',
          sourcePath: 'tools/hotels-api.tools.abl',
        },
      ];

      const manifest = generateManifest(makeInput({ edges }));

      expect(manifest.dependencies.tool_imports).toHaveLength(1);
      expect(manifest.dependencies.tool_imports[0].tools).toEqual([]);
    });

    it('should skip inline_handoff edges from agent_references and tool_imports', () => {
      const edges: DependencyEdge[] = [{ from: 'Main', to: 'Worker', type: 'inline_handoff' }];

      const manifest = generateManifest(makeInput({ edges }));

      expect(manifest.dependencies.agent_references).toHaveLength(0);
      expect(manifest.dependencies.tool_imports).toHaveLength(0);
    });

    it('should handle null description and entry_agent', () => {
      const input = makeInput({
        projectDescription: null,
        entryAgent: null,
      });

      const manifest = generateManifest(input);

      expect(manifest.description).toBeNull();
      expect(manifest.entry_agent).toBeNull();
    });

    it('should handle multiple agents', () => {
      const input = makeInput({
        agents: [
          {
            name: 'Main',
            description: null,
            ownerId: null,
            ownerTeamId: null,
            version: null,
          },
          {
            name: 'Worker',
            description: 'Worker',
            ownerId: 'u1',
            ownerTeamId: null,
            version: '2.0',
          },
          {
            name: 'Helper',
            description: null,
            ownerId: null,
            ownerTeamId: 't1',
            version: null,
          },
        ],
      });

      const manifest = generateManifest(input);

      expect(Object.keys(manifest.agents)).toHaveLength(3);
      expect(manifest.agents['Helper'].ownerTeam).toBe('t1');
    });

    it('should handle tool_import edge without sourcePath', () => {
      const edges: DependencyEdge[] = [
        {
          from: 'Worker',
          to: 'hotels-api',
          type: 'tool_import',
          // no sourcePath
        },
      ];

      const manifest = generateManifest(makeInput({ edges }));

      // Without sourcePath, the edge.type is tool_import but the condition
      // requires edge.sourcePath to be truthy, so it should not be included
      expect(manifest.dependencies.tool_imports).toHaveLength(0);
    });
  });
});

// ─── Manifest Generator v2 ──────────────────────────────────────────────────

describe('manifest-generator-v2', () => {
  describe('generateManifestV2', () => {
    function makeInputV2(overrides: Partial<ManifestInputV2> = {}): ManifestInputV2 {
      return {
        projectName: 'Test Project',
        projectSlug: 'test-project',
        projectDescription: 'A test project',
        exportedBy: 'user-1',
        entryAgent: 'Main',
        agents: [
          {
            name: 'Main',
            description: 'Supervisor agent',
            ownerId: 'user-1',
            ownerTeamId: 'team-1',
            version: '1.0',
          },
        ],
        tools: [{ name: 'search-api', ownerId: 'user-2' }],
        edges: [],
        layers: ['core', 'connections', 'guardrails'],
        entityCounts: { agents: 1, tools: 1, connections: 3 },
        requiredEnvVars: ['OPENAI_API_KEY', 'SLACK_TOKEN'],
        requiredConnectors: ['salesforce'],
        requiredMcpServers: ['internal-tools'],
        ...overrides,
      };
    }

    it('should set format_version to 2.0', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.format_version).toBe('2.0');
    });

    it('should include layers_included', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.layers_included).toEqual(['core', 'connections', 'guardrails']);
    });

    it('should include metadata block with entity counts', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.metadata.entity_counts).toEqual({ agents: 1, tools: 1, connections: 3 });
    });

    it('should include required_env_vars from DSL parsing', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.metadata.required_env_vars).toEqual(['OPENAI_API_KEY', 'SLACK_TOKEN']);
    });

    it('should include required_connectors', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.metadata.required_connectors).toEqual(['salesforce']);
    });

    it('should include required_mcp_servers', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.metadata.required_mcp_servers).toEqual(['internal-tools']);
    });

    it('should map agents with correct paths', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.agents['Main'].path).toBe('agents/main.agent.yaml');
      expect(manifest.agents['Main'].owner).toBe('user-1');
    });

    it('should map tools with correct paths', () => {
      const manifest = generateManifestV2(makeInputV2());
      expect(manifest.tools['search-api'].path).toBe('tools/search-api.tools.abl');
    });

    it('should include behavior_profiles when provided', () => {
      const manifest = generateManifestV2(
        makeInputV2({
          profiles: [
            { name: 'formal', priority: 1, whenSummary: 'formal requests', usedBy: ['Main'] },
          ],
        }),
      );
      expect(manifest.behavior_profiles).toBeDefined();
      expect(manifest.behavior_profiles!['formal'].name).toBe('formal');
    });

    it('should handle empty metadata arrays', () => {
      const manifest = generateManifestV2(
        makeInputV2({
          requiredEnvVars: [],
          requiredConnectors: [],
          requiredMcpServers: [],
        }),
      );
      expect(manifest.metadata.required_env_vars).toEqual([]);
      expect(manifest.metadata.required_connectors).toEqual([]);
      expect(manifest.metadata.required_mcp_servers).toEqual([]);
    });

    it('should handle all 8 layers', () => {
      const allLayers: ManifestInputV2['layers'] = [
        'core',
        'connections',
        'guardrails',
        'workflows',
        'evals',
        'search',
        'channels',
        'vocabulary',
      ];
      const manifest = generateManifestV2(makeInputV2({ layers: allLayers }));
      expect(manifest.layers_included).toHaveLength(8);
    });

    it('should include exported_at timestamp', () => {
      const before = new Date().toISOString();
      const manifest = generateManifestV2(makeInputV2());
      const after = new Date().toISOString();
      expect(manifest.exported_at >= before).toBe(true);
      expect(manifest.exported_at <= after).toBe(true);
    });
  });
});

// ─── Deployment Exporter ────────────────────────────────────────────────────

describe('deployment-exporter', () => {
  describe('exportDeployments', () => {
    it('should convert deployment records to files', () => {
      const deployments: DeploymentRecord[] = [
        {
          environment: 'dev',
          status: 'active',
          agentVersions: { Main: '1.0', Worker: '1.0' },
          config: { debug: true },
          createdAt: new Date('2024-01-15T10:00:00Z'),
          deployedBy: 'user-1',
        },
      ];

      const files = exportDeployments(deployments);

      expect(files.size).toBe(1);
      expect(files.has('dev.deployment.json')).toBe(true);

      const parsed = JSON.parse(files.get('dev.deployment.json')!);
      expect(parsed.environment).toBe('dev');
      expect(parsed.status).toBe('active');
      expect(parsed.agent_versions).toEqual({ Main: '1.0', Worker: '1.0' });
      expect(parsed.config).toEqual({ debug: true });
      expect(parsed.deployed_at).toBe('2024-01-15T10:00:00.000Z');
      expect(parsed.deployed_by).toBe('user-1');
    });

    it('should handle multiple deployments', () => {
      const deployments: DeploymentRecord[] = [
        {
          environment: 'dev',
          status: 'active',
          agentVersions: {},
          config: {},
          createdAt: new Date('2024-01-15'),
          deployedBy: 'user-1',
        },
        {
          environment: 'staging',
          status: 'pending',
          agentVersions: {},
          config: {},
          createdAt: new Date('2024-01-16'),
          deployedBy: 'user-2',
        },
        {
          environment: 'production',
          status: 'active',
          agentVersions: {},
          config: {},
          createdAt: new Date('2024-01-17'),
          deployedBy: 'user-1',
        },
      ];

      const files = exportDeployments(deployments);

      expect(files.size).toBe(3);
      expect(files.has('dev.deployment.json')).toBe(true);
      expect(files.has('staging.deployment.json')).toBe(true);
      expect(files.has('production.deployment.json')).toBe(true);
    });

    it('should return empty map for empty deployments array', () => {
      const files = exportDeployments([]);
      expect(files.size).toBe(0);
    });

    it('should produce valid JSON for each deployment file', () => {
      const deployments: DeploymentRecord[] = [
        {
          environment: 'dev',
          status: 'active',
          agentVersions: { Agent: '1.0' },
          config: { nested: { deep: true } },
          createdAt: new Date(),
          deployedBy: 'user-1',
        },
      ];

      const files = exportDeployments(deployments);
      const content = files.get('dev.deployment.json')!;

      // Should be pretty-printed (2-space indent)
      expect(content).toContain('\n');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('should use ISO string format for deployed_at', () => {
      const specificDate = new Date('2024-06-15T14:30:00.000Z');
      const deployments: DeploymentRecord[] = [
        {
          environment: 'production',
          status: 'active',
          agentVersions: {},
          config: {},
          createdAt: specificDate,
          deployedBy: 'admin',
        },
      ];

      const files = exportDeployments(deployments);
      const parsed = JSON.parse(files.get('production.deployment.json')!);
      expect(parsed.deployed_at).toBe('2024-06-15T14:30:00.000Z');
    });
  });
});
