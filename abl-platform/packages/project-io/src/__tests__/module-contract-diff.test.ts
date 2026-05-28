import { describe, it, expect } from 'vitest';
import type { ModuleReleaseContract } from '@agent-platform/database/models';
import { diffModuleContracts } from '../module-release/module-contract-diff.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal valid contract with optional overrides. */
function makeContract(overrides: Partial<ModuleReleaseContract> = {}): ModuleReleaseContract {
  return {
    providedAgents: [],
    providedTools: [],
    requiredConfigKeys: [],
    requiredEnvVars: [],
    requiredAuthProfiles: [],
    requiredConnectors: [],
    requiredMcpServers: [],
    warnings: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('diffModuleContracts', () => {
  // 1. Identical contracts → no changes
  it('returns no changes for identical contracts', () => {
    const contract = makeContract({
      providedAgents: [{ name: 'AgentA', description: 'does stuff' }],
      providedTools: [{ name: 'ToolA', toolType: 'http' }],
      requiredEnvVars: [{ name: 'API_KEY' }],
    });

    const diff = diffModuleContracts(contract, contract);

    expect(diff.agents).toEqual([]);
    expect(diff.tools).toEqual([]);
    expect(diff.configKeys).toEqual([]);
    expect(diff.envVars).toEqual([]);
    expect(diff.authProfiles).toEqual([]);
    expect(diff.connectors).toEqual([]);
    expect(diff.mcpServers).toEqual([]);
    expect(diff.warnings).toEqual([]);
    expect(diff.hasBreakingChanges).toBe(false);
    expect(diff.summary).toBe('No changes');
  });

  // 2. Agent added → non-breaking
  it('classifies an added agent as non-breaking', () => {
    const current = makeContract({
      providedAgents: [{ name: 'AgentA' }],
    });
    const target = makeContract({
      providedAgents: [{ name: 'AgentA' }, { name: 'AgentB' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.agents).toHaveLength(1);
    expect(diff.agents[0]).toMatchObject({
      name: 'AgentB',
      change: 'added',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 3. Agent removed → breaking
  it('classifies a removed agent as breaking', () => {
    const current = makeContract({
      providedAgents: [{ name: 'AgentA' }, { name: 'AgentB' }],
    });
    const target = makeContract({
      providedAgents: [{ name: 'AgentA' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.agents).toHaveLength(1);
    expect(diff.agents[0]).toMatchObject({
      name: 'AgentB',
      change: 'removed',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 4. Tool added → non-breaking
  it('classifies an added tool as non-breaking', () => {
    const current = makeContract({
      providedTools: [{ name: 'ToolA', toolType: 'http' }],
    });
    const target = makeContract({
      providedTools: [
        { name: 'ToolA', toolType: 'http' },
        { name: 'ToolB', toolType: 'mcp' },
      ],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.tools).toHaveLength(1);
    expect(diff.tools[0]).toMatchObject({
      name: 'ToolB',
      change: 'added',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 5. Tool removed → breaking
  it('classifies a removed tool as breaking', () => {
    const current = makeContract({
      providedTools: [
        { name: 'ToolA', toolType: 'http' },
        { name: 'ToolB', toolType: 'mcp' },
      ],
    });
    const target = makeContract({
      providedTools: [{ name: 'ToolA', toolType: 'http' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.tools).toHaveLength(1);
    expect(diff.tools[0]).toMatchObject({
      name: 'ToolB',
      change: 'removed',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 6. New required env var → breaking
  it('classifies a new required env var as breaking', () => {
    const current = makeContract({
      requiredEnvVars: [{ name: 'API_KEY' }],
    });
    const target = makeContract({
      requiredEnvVars: [{ name: 'API_KEY' }, { name: 'SECRET_TOKEN' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.envVars).toHaveLength(1);
    expect(diff.envVars[0]).toMatchObject({
      name: 'SECRET_TOKEN',
      change: 'added',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 7. Removed required env var → non-breaking
  it('classifies a removed env var as non-breaking', () => {
    const current = makeContract({
      requiredEnvVars: [{ name: 'API_KEY' }, { name: 'SECRET_TOKEN' }],
    });
    const target = makeContract({
      requiredEnvVars: [{ name: 'API_KEY' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.envVars).toHaveLength(1);
    expect(diff.envVars[0]).toMatchObject({
      name: 'SECRET_TOKEN',
      change: 'removed',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 8. New required auth profile → breaking
  it('classifies a new required auth profile as breaking', () => {
    const current = makeContract({
      requiredAuthProfiles: [],
    });
    const target = makeContract({
      requiredAuthProfiles: [{ name: 'oauth-github', referencedBy: ['AgentA'] }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.authProfiles).toHaveLength(1);
    expect(diff.authProfiles[0]).toMatchObject({
      name: 'oauth-github',
      change: 'added',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 9. Removed required auth profile → non-breaking
  it('classifies a removed auth profile as non-breaking', () => {
    const current = makeContract({
      requiredAuthProfiles: [{ name: 'oauth-github', referencedBy: ['AgentA'] }],
    });
    const target = makeContract({
      requiredAuthProfiles: [],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.authProfiles).toHaveLength(1);
    expect(diff.authProfiles[0]).toMatchObject({
      name: 'oauth-github',
      change: 'removed',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 10. New required connector → breaking
  it('classifies a new required connector as breaking', () => {
    const current = makeContract({
      requiredConnectors: [],
    });
    const target = makeContract({
      requiredConnectors: [{ name: 'salesforce-api' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.connectors).toHaveLength(1);
    expect(diff.connectors[0]).toMatchObject({
      name: 'salesforce-api',
      change: 'added',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 11. New required MCP server → breaking
  it('classifies a new required MCP server as breaking', () => {
    const current = makeContract({
      requiredMcpServers: [],
    });
    const target = makeContract({
      requiredMcpServers: [{ name: 'code-analysis-mcp' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.mcpServers).toHaveLength(1);
    expect(diff.mcpServers[0]).toMatchObject({
      name: 'code-analysis-mcp',
      change: 'added',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 12. Mixed breaking/non-breaking changes
  it('correctly classifies a mix of breaking and non-breaking changes', () => {
    const current = makeContract({
      providedAgents: [{ name: 'AgentA' }, { name: 'AgentB' }],
      providedTools: [{ name: 'ToolA', toolType: 'http' }],
      requiredEnvVars: [{ name: 'OLD_VAR' }],
      requiredConnectors: [{ name: 'old-connector' }],
    });
    const target = makeContract({
      providedAgents: [{ name: 'AgentA' }, { name: 'AgentC' }],
      providedTools: [
        { name: 'ToolA', toolType: 'http' },
        { name: 'ToolB', toolType: 'mcp' },
      ],
      requiredEnvVars: [{ name: 'OLD_VAR' }, { name: 'NEW_VAR' }],
      requiredConnectors: [],
    });

    const diff = diffModuleContracts(current, target);

    // AgentB removed → breaking
    expect(diff.agents).toContainEqual(
      expect.objectContaining({ name: 'AgentB', change: 'removed', severity: 'breaking' }),
    );
    // AgentC added → non-breaking
    expect(diff.agents).toContainEqual(
      expect.objectContaining({ name: 'AgentC', change: 'added', severity: 'non-breaking' }),
    );
    // ToolB added → non-breaking
    expect(diff.tools).toContainEqual(
      expect.objectContaining({ name: 'ToolB', change: 'added', severity: 'non-breaking' }),
    );
    // NEW_VAR added → breaking
    expect(diff.envVars).toContainEqual(
      expect.objectContaining({ name: 'NEW_VAR', change: 'added', severity: 'breaking' }),
    );
    // old-connector removed → non-breaking
    expect(diff.connectors).toContainEqual(
      expect.objectContaining({
        name: 'old-connector',
        change: 'removed',
        severity: 'non-breaking',
      }),
    );

    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 13. Empty contracts (both empty) → no changes
  it('returns no changes for two empty contracts', () => {
    const current = makeContract();
    const target = makeContract();

    const diff = diffModuleContracts(current, target);

    expect(diff.agents).toEqual([]);
    expect(diff.tools).toEqual([]);
    expect(diff.configKeys).toEqual([]);
    expect(diff.envVars).toEqual([]);
    expect(diff.authProfiles).toEqual([]);
    expect(diff.connectors).toEqual([]);
    expect(diff.mcpServers).toEqual([]);
    expect(diff.hasBreakingChanges).toBe(false);
    expect(diff.summary).toBe('No changes');
  });

  // 14. Changed config key (isSecret changed) → warn
  it('classifies a config key isSecret change as warn', () => {
    const current = makeContract({
      requiredConfigKeys: [{ key: 'API_URL', isSecret: false }],
    });
    const target = makeContract({
      requiredConfigKeys: [{ key: 'API_URL', isSecret: true }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.configKeys).toHaveLength(1);
    expect(diff.configKeys[0]).toMatchObject({
      name: 'API_URL',
      change: 'modified',
      severity: 'warn',
    });
    expect(diff.configKeys[0].detail).toContain('non-secret');
    expect(diff.configKeys[0].detail).toContain('secret');
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 15. Summary string format verification
  it('builds correct summary for various change counts', () => {
    // Only breaking changes
    const diff1 = diffModuleContracts(
      makeContract({ providedAgents: [{ name: 'A' }] }),
      makeContract({ providedAgents: [] }),
    );
    expect(diff1.summary).toBe('1 breaking change');

    // Only non-breaking changes
    const diff2 = diffModuleContracts(
      makeContract({ providedAgents: [] }),
      makeContract({ providedAgents: [{ name: 'A' }] }),
    );
    expect(diff2.summary).toBe('1 non-breaking change');

    // Mixed breaking and non-breaking
    const diff3 = diffModuleContracts(
      makeContract({
        providedAgents: [{ name: 'A' }],
        providedTools: [],
      }),
      makeContract({
        providedAgents: [],
        providedTools: [{ name: 'T1', toolType: 'http' }],
      }),
    );
    expect(diff3.summary).toBe('1 breaking, 1 non-breaking changes');
  });

  // 16. Tool type changed → warn
  it('classifies a tool type change as warn', () => {
    const current = makeContract({
      providedTools: [{ name: 'ToolA', toolType: 'http' }],
    });
    const target = makeContract({
      providedTools: [{ name: 'ToolA', toolType: 'mcp' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.tools).toHaveLength(1);
    expect(diff.tools[0]).toMatchObject({
      name: 'ToolA',
      change: 'modified',
      severity: 'warn',
    });
    expect(diff.tools[0].detail).toContain('http');
    expect(diff.tools[0].detail).toContain('mcp');
  });

  // 17. Agent description changed → warn
  it('classifies an agent description change as warn', () => {
    const current = makeContract({
      providedAgents: [{ name: 'AgentA', description: 'Original description' }],
    });
    const target = makeContract({
      providedAgents: [{ name: 'AgentA', description: 'Updated description' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.agents).toHaveLength(1);
    expect(diff.agents[0]).toMatchObject({
      name: 'AgentA',
      change: 'modified',
      severity: 'warn',
    });
    expect(diff.warnings).toHaveLength(1);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 18. New config key → breaking
  it('classifies a new required config key as breaking', () => {
    const current = makeContract({
      requiredConfigKeys: [],
    });
    const target = makeContract({
      requiredConfigKeys: [{ key: 'NEW_CONFIG', isSecret: false }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.configKeys).toHaveLength(1);
    expect(diff.configKeys[0]).toMatchObject({
      name: 'NEW_CONFIG',
      change: 'added',
      severity: 'breaking',
    });
    expect(diff.hasBreakingChanges).toBe(true);
  });

  // 19. Removed config key → non-breaking
  it('classifies a removed config key as non-breaking', () => {
    const current = makeContract({
      requiredConfigKeys: [{ key: 'OLD_CONFIG', isSecret: false }],
    });
    const target = makeContract({
      requiredConfigKeys: [],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.configKeys).toHaveLength(1);
    expect(diff.configKeys[0]).toMatchObject({
      name: 'OLD_CONFIG',
      change: 'removed',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 20. Removed connector → non-breaking
  it('classifies a removed connector as non-breaking', () => {
    const current = makeContract({
      requiredConnectors: [{ name: 'old-connector' }],
    });
    const target = makeContract({
      requiredConnectors: [],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.connectors).toHaveLength(1);
    expect(diff.connectors[0]).toMatchObject({
      name: 'old-connector',
      change: 'removed',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 21. Removed MCP server → non-breaking
  it('classifies a removed MCP server as non-breaking', () => {
    const current = makeContract({
      requiredMcpServers: [{ name: 'old-mcp' }],
    });
    const target = makeContract({
      requiredMcpServers: [],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.mcpServers).toHaveLength(1);
    expect(diff.mcpServers[0]).toMatchObject({
      name: 'old-mcp',
      change: 'removed',
      severity: 'non-breaking',
    });
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 22. Summary with warnings
  it('includes warning count in summary', () => {
    const current = makeContract({
      providedAgents: [{ name: 'AgentA', description: 'old' }],
    });
    const target = makeContract({
      providedAgents: [{ name: 'AgentA', description: 'new' }],
    });

    const diff = diffModuleContracts(current, target);

    expect(diff.summary).toBe('1 warning change');
    expect(diff.warnings).toHaveLength(1);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  // 23. Large realistic contract diff
  it('handles a realistic multi-category diff correctly', () => {
    const current = makeContract({
      providedAgents: [
        { name: 'SupportAgent', description: 'Handles support tickets' },
        { name: 'TriageAgent', description: 'Triages incoming requests' },
      ],
      providedTools: [
        { name: 'search-kb', toolType: 'http' },
        { name: 'create-ticket', toolType: 'http' },
      ],
      requiredEnvVars: [{ name: 'ZENDESK_API_KEY' }, { name: 'JIRA_TOKEN' }],
      requiredAuthProfiles: [{ name: 'zendesk-oauth', referencedBy: ['SupportAgent'] }],
      requiredConnectors: [{ name: 'zendesk-connector' }],
      requiredMcpServers: [],
      requiredConfigKeys: [
        { key: 'MAX_RETRIES', isSecret: false },
        { key: 'WEBHOOK_SECRET', isSecret: true },
      ],
      warnings: [],
    });

    const target = makeContract({
      providedAgents: [
        { name: 'SupportAgent', description: 'Updated support handler' },
        { name: 'EscalationAgent', description: 'Handles escalations' },
      ],
      providedTools: [
        { name: 'search-kb', toolType: 'mcp' }, // type changed
        { name: 'create-ticket', toolType: 'http' },
        { name: 'slack-notify', toolType: 'http' },
      ],
      requiredEnvVars: [{ name: 'ZENDESK_API_KEY' }, { name: 'SLACK_TOKEN' }],
      requiredAuthProfiles: [
        { name: 'zendesk-oauth', referencedBy: ['SupportAgent'] },
        { name: 'slack-oauth', referencedBy: ['EscalationAgent'] },
      ],
      requiredConnectors: [{ name: 'zendesk-connector' }, { name: 'slack-connector' }],
      requiredMcpServers: [{ name: 'analytics-mcp' }],
      requiredConfigKeys: [
        { key: 'MAX_RETRIES', isSecret: false },
        { key: 'WEBHOOK_SECRET', isSecret: true },
        { key: 'SLACK_CHANNEL', isSecret: false },
      ],
      warnings: [],
    });

    const diff = diffModuleContracts(current, target);

    // Agent changes
    expect(diff.agents).toContainEqual(
      expect.objectContaining({ name: 'TriageAgent', change: 'removed', severity: 'breaking' }),
    );
    expect(diff.agents).toContainEqual(
      expect.objectContaining({
        name: 'EscalationAgent',
        change: 'added',
        severity: 'non-breaking',
      }),
    );
    expect(diff.agents).toContainEqual(
      expect.objectContaining({ name: 'SupportAgent', change: 'modified', severity: 'warn' }),
    );

    // Tool changes
    expect(diff.tools).toContainEqual(
      expect.objectContaining({ name: 'search-kb', change: 'modified', severity: 'warn' }),
    );
    expect(diff.tools).toContainEqual(
      expect.objectContaining({ name: 'slack-notify', change: 'added', severity: 'non-breaking' }),
    );

    // Env var changes
    expect(diff.envVars).toContainEqual(
      expect.objectContaining({ name: 'JIRA_TOKEN', change: 'removed', severity: 'non-breaking' }),
    );
    expect(diff.envVars).toContainEqual(
      expect.objectContaining({ name: 'SLACK_TOKEN', change: 'added', severity: 'breaking' }),
    );

    // Auth profile changes
    expect(diff.authProfiles).toContainEqual(
      expect.objectContaining({ name: 'slack-oauth', change: 'added', severity: 'breaking' }),
    );

    // Connector changes
    expect(diff.connectors).toContainEqual(
      expect.objectContaining({
        name: 'slack-connector',
        change: 'added',
        severity: 'breaking',
      }),
    );

    // MCP server changes
    expect(diff.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'analytics-mcp', change: 'added', severity: 'breaking' }),
    );

    // Config key changes
    expect(diff.configKeys).toContainEqual(
      expect.objectContaining({ name: 'SLACK_CHANNEL', change: 'added', severity: 'breaking' }),
    );

    expect(diff.hasBreakingChanges).toBe(true);

    // Summary should include both breaking and non-breaking counts
    expect(diff.summary).toContain('breaking');
    expect(diff.summary).toContain('non-breaking');
  });
});
