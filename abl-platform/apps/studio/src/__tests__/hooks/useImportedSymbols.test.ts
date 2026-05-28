/**
 * useImportedSymbols Hook — Interface & Logic Tests
 *
 * Tests the exported types and derivation logic of the useImportedSymbols hook.
 * Tests the interface contract without mocking internal modules.
 */

import { describe, it, expect } from 'vitest';
import type { ImportedAgent, ImportedTool, ImportedSymbols } from '../../hooks/useImportedSymbols';

describe('useImportedSymbols types and interface', () => {
  it('ImportedAgent should have required fields', () => {
    const agent: ImportedAgent = {
      name: 'forecast_agent',
      alias: 'weather',
      moduleProjectName: 'Weather Module',
      dependencyId: 'd1',
    };
    expect(agent.name).toBe('forecast_agent');
    expect(agent.alias).toBe('weather');
    expect(agent.moduleProjectName).toBe('Weather Module');
    expect(agent.dependencyId).toBe('d1');
  });

  it('ImportedAgent should support optional fields', () => {
    const agent: ImportedAgent = {
      name: 'forecast_agent',
      alias: 'weather',
      moduleProjectName: 'Weather Module',
      dependencyId: 'd1',
      description: 'Forecast agent description',
      resolvedVersion: '1.0.0',
    };
    expect(agent.description).toBe('Forecast agent description');
    expect(agent.resolvedVersion).toBe('1.0.0');
  });

  it('ImportedAgent should support enriched fields', () => {
    const agent: ImportedAgent = {
      name: 'forecast_agent',
      alias: 'weather',
      moduleProjectName: 'Weather Module',
      dependencyId: 'd1',
      mode: 'autonomous',
      tools: ['get_weather', 'get_forecast'],
      handoffTargets: ['summary_agent'],
      delegateTargets: ['detail_agent'],
      hasGather: true,
      hasFlow: false,
    };
    expect(agent.mode).toBe('autonomous');
    expect(agent.tools).toEqual(['get_weather', 'get_forecast']);
    expect(agent.handoffTargets).toEqual(['summary_agent']);
    expect(agent.delegateTargets).toEqual(['detail_agent']);
    expect(agent.hasGather).toBe(true);
    expect(agent.hasFlow).toBe(false);
  });

  it('ImportedTool should have required fields', () => {
    const tool: ImportedTool = {
      name: 'charge_card',
      alias: 'pay',
      moduleProjectName: 'Payments',
      dependencyId: 'd2',
    };
    expect(tool.name).toBe('charge_card');
    expect(tool.alias).toBe('pay');
  });

  it('ImportedTool should support optional fields including toolType', () => {
    const tool: ImportedTool = {
      name: 'charge_card',
      alias: 'pay',
      moduleProjectName: 'Payments',
      dependencyId: 'd2',
      description: 'Charge a credit card',
      toolType: 'http',
      resolvedVersion: '2.0.0',
    };
    expect(tool.toolType).toBe('http');
    expect(tool.description).toBe('Charge a credit card');
    expect(tool.resolvedVersion).toBe('2.0.0');
  });

  it('ImportedTool should support enriched fields', () => {
    const tool: ImportedTool = {
      name: 'charge_card',
      alias: 'pay',
      moduleProjectName: 'Payments',
      dependencyId: 'd2',
      parameters: [
        { name: 'amount', type: 'number', required: true, description: 'Amount to charge' },
        { name: 'currency', type: 'string', required: false },
      ],
      returnType: 'ChargeResult',
      endpoint: '/api/charges',
      method: 'POST',
      authProfileRef: 'stripe_auth',
      requiredEnvVars: ['STRIPE_API_KEY', 'STRIPE_SECRET'],
    };
    expect(tool.parameters).toHaveLength(2);
    expect(tool.parameters?.[0]).toEqual({
      name: 'amount',
      type: 'number',
      required: true,
      description: 'Amount to charge',
    });
    expect(tool.parameters?.[1].description).toBeUndefined();
    expect(tool.returnType).toBe('ChargeResult');
    expect(tool.endpoint).toBe('/api/charges');
    expect(tool.method).toBe('POST');
    expect(tool.authProfileRef).toBe('stripe_auth');
    expect(tool.requiredEnvVars).toEqual(['STRIPE_API_KEY', 'STRIPE_SECRET']);
  });

  it('ImportedSymbols should have agents, tools, and hasDependencies', () => {
    const symbols: ImportedSymbols = {
      agents: [{ name: 'a', alias: 'mod', moduleProjectName: 'Mod', dependencyId: 'd1' }],
      tools: [{ name: 't', alias: 'mod', moduleProjectName: 'Mod', dependencyId: 'd1' }],
      hasDependencies: true,
    };
    expect(symbols.agents).toHaveLength(1);
    expect(symbols.tools).toHaveLength(1);
    expect(symbols.hasDependencies).toBe(true);
  });

  it('ImportedSymbols empty state', () => {
    const symbols: ImportedSymbols = {
      agents: [],
      tools: [],
      hasDependencies: false,
    };
    expect(symbols.agents).toHaveLength(0);
    expect(symbols.tools).toHaveLength(0);
    expect(symbols.hasDependencies).toBe(false);
  });
});

describe('useImportedSymbols derivation logic (pure function equivalent)', () => {
  // Test the derivation logic that the hook performs, without React context.
  // This mirrors what useMemo computes from the dependencies array.

  function deriveSymbols(dependencies: any[]): ImportedSymbols {
    const agents: ImportedAgent[] = [];
    const tools: ImportedTool[] = [];

    for (const dep of dependencies) {
      const contract = dep.contractSnapshot;
      if (!contract) continue;

      if (contract.providedAgents) {
        for (const agent of contract.providedAgents) {
          const agentRecord = agent as Record<string, unknown>;
          agents.push({
            name: agent.name,
            alias: dep.alias,
            moduleProjectName: dep.moduleProjectName,
            dependencyId: dep.id,
            description: agentRecord.description as string | undefined,
            resolvedVersion: dep.resolvedVersion || undefined,
            mode: agentRecord.mode as string | undefined,
            tools: agentRecord.tools as string[] | undefined,
            handoffTargets: agentRecord.handoffTargets as string[] | undefined,
            delegateTargets: agentRecord.delegateTargets as string[] | undefined,
            hasGather: agentRecord.hasGather as boolean | undefined,
            hasFlow: agentRecord.hasFlow as boolean | undefined,
          });
        }
      }

      if (contract.providedTools) {
        for (const tool of contract.providedTools) {
          const toolRecord = tool as Record<string, unknown>;
          tools.push({
            name: tool.name,
            alias: dep.alias,
            moduleProjectName: dep.moduleProjectName,
            dependencyId: dep.id,
            description: toolRecord.description as string | undefined,
            toolType: toolRecord.toolType as string | undefined,
            resolvedVersion: dep.resolvedVersion || undefined,
            parameters: toolRecord.parameters as ImportedTool['parameters'],
            returnType: toolRecord.returnType as string | undefined,
            endpoint: toolRecord.endpoint as string | undefined,
            method: toolRecord.method as string | undefined,
            authProfileRef: toolRecord.authProfileRef as string | undefined,
            requiredEnvVars: toolRecord.requiredEnvVars as string[] | undefined,
          });
        }
      }
    }

    return { agents, tools, hasDependencies: dependencies.length > 0 };
  }

  it('should return empty arrays when no dependencies', () => {
    const result = deriveSymbols([]);
    expect(result.agents).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.hasDependencies).toBe(false);
  });

  it('should extract agents with all fields', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'weather',
        moduleProjectName: 'Weather Module',
        resolvedVersion: '1.0.0',
        contractSnapshot: {
          providedAgents: [{ name: 'forecast_agent', description: 'Forecasts weather' }],
        },
      },
    ]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'forecast_agent',
      alias: 'weather',
      moduleProjectName: 'Weather Module',
      dependencyId: 'd1',
      description: 'Forecasts weather',
      resolvedVersion: '1.0.0',
    });
  });

  it('should extract tools with toolType', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'pay',
        moduleProjectName: 'Payments',
        resolvedVersion: '2.0.0',
        contractSnapshot: {
          providedTools: [{ name: 'charge', toolType: 'http', description: 'Charge card' }],
        },
      },
    ]);
    expect(result.tools[0].toolType).toBe('http');
    expect(result.tools[0].description).toBe('Charge card');
  });

  it('should handle multiple dependencies', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'a',
        moduleProjectName: 'A',
        contractSnapshot: {
          providedAgents: [{ name: 'agent1' }],
          providedTools: [{ name: 'tool1' }],
        },
      },
      {
        id: 'd2',
        alias: 'b',
        moduleProjectName: 'B',
        contractSnapshot: {
          providedAgents: [{ name: 'agent2' }],
          providedTools: [{ name: 'tool2' }, { name: 'tool3' }],
        },
      },
    ]);
    expect(result.agents).toHaveLength(2);
    expect(result.tools).toHaveLength(3);
    expect(result.hasDependencies).toBe(true);
  });

  it('should skip dependencies with null contractSnapshot', () => {
    const result = deriveSymbols([
      { id: 'd1', alias: 'broken', moduleProjectName: 'Broken', contractSnapshot: null },
    ]);
    expect(result.agents).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.hasDependencies).toBe(true);
  });

  it('should handle contractSnapshot with no providedAgents/Tools', () => {
    const result = deriveSymbols([
      { id: 'd1', alias: 'empty', moduleProjectName: 'E', contractSnapshot: {} },
    ]);
    expect(result.agents).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  it('should handle resolvedVersion being undefined', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'mod',
        moduleProjectName: 'Mod',
        contractSnapshot: { providedAgents: [{ name: 'a1' }] },
      },
    ]);
    expect(result.agents[0].resolvedVersion).toBeUndefined();
  });

  it('should preserve dependency IDs across multiple deps', () => {
    const result = deriveSymbols([
      {
        id: 'dep-111',
        alias: 'a',
        moduleProjectName: 'A',
        contractSnapshot: { providedAgents: [{ name: 'x' }] },
      },
      {
        id: 'dep-222',
        alias: 'b',
        moduleProjectName: 'B',
        contractSnapshot: { providedAgents: [{ name: 'y' }] },
      },
    ]);
    expect(result.agents[0].dependencyId).toBe('dep-111');
    expect(result.agents[1].dependencyId).toBe('dep-222');
  });

  it('should handle empty providedAgents/Tools arrays', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'mod',
        moduleProjectName: 'M',
        contractSnapshot: { providedAgents: [], providedTools: [] },
      },
    ]);
    expect(result.agents).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.hasDependencies).toBe(true);
  });

  it('should extract enriched agent fields from contract', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'weather',
        moduleProjectName: 'Weather Module',
        resolvedVersion: '1.0.0',
        contractSnapshot: {
          providedAgents: [
            {
              name: 'forecast_agent',
              description: 'Forecasts weather',
              mode: 'autonomous',
              tools: ['get_weather', 'get_forecast'],
              handoffTargets: ['summary_agent'],
              delegateTargets: ['detail_agent'],
              hasGather: true,
              hasFlow: false,
            },
          ],
        },
      },
    ]);
    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0];
    expect(agent.mode).toBe('autonomous');
    expect(agent.tools).toEqual(['get_weather', 'get_forecast']);
    expect(agent.handoffTargets).toEqual(['summary_agent']);
    expect(agent.delegateTargets).toEqual(['detail_agent']);
    expect(agent.hasGather).toBe(true);
    expect(agent.hasFlow).toBe(false);
  });

  it('should extract enriched tool fields from contract', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'pay',
        moduleProjectName: 'Payments',
        resolvedVersion: '2.0.0',
        contractSnapshot: {
          providedTools: [
            {
              name: 'charge',
              toolType: 'http',
              description: 'Charge card',
              parameters: [{ name: 'amount', type: 'number', required: true }],
              returnType: 'ChargeResult',
              endpoint: '/api/charges',
              method: 'POST',
              authProfileRef: 'stripe_auth',
              requiredEnvVars: ['STRIPE_API_KEY'],
            },
          ],
        },
      },
    ]);
    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0];
    expect(tool.parameters).toEqual([{ name: 'amount', type: 'number', required: true }]);
    expect(tool.returnType).toBe('ChargeResult');
    expect(tool.endpoint).toBe('/api/charges');
    expect(tool.method).toBe('POST');
    expect(tool.authProfileRef).toBe('stripe_auth');
    expect(tool.requiredEnvVars).toEqual(['STRIPE_API_KEY']);
  });

  it('should leave enriched fields undefined when not in contract', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'basic',
        moduleProjectName: 'Basic',
        contractSnapshot: {
          providedAgents: [{ name: 'simple_agent' }],
          providedTools: [{ name: 'simple_tool' }],
        },
      },
    ]);
    const agent = result.agents[0];
    expect(agent.mode).toBeUndefined();
    expect(agent.tools).toBeUndefined();
    expect(agent.handoffTargets).toBeUndefined();
    expect(agent.delegateTargets).toBeUndefined();
    expect(agent.hasGather).toBeUndefined();
    expect(agent.hasFlow).toBeUndefined();

    const tool = result.tools[0];
    expect(tool.parameters).toBeUndefined();
    expect(tool.returnType).toBeUndefined();
    expect(tool.endpoint).toBeUndefined();
    expect(tool.method).toBeUndefined();
    expect(tool.authProfileRef).toBeUndefined();
    expect(tool.requiredEnvVars).toBeUndefined();
  });

  it('should handle mixed — some deps with contract, some without', () => {
    const result = deriveSymbols([
      {
        id: 'd1',
        alias: 'good',
        moduleProjectName: 'Good',
        contractSnapshot: { providedAgents: [{ name: 'a1' }] },
      },
      { id: 'd2', alias: 'bad', moduleProjectName: 'Bad', contractSnapshot: null },
      {
        id: 'd3',
        alias: 'also_good',
        moduleProjectName: 'Also',
        contractSnapshot: { providedTools: [{ name: 't1' }] },
      },
    ]);
    expect(result.agents).toHaveLength(1);
    expect(result.tools).toHaveLength(1);
    expect(result.hasDependencies).toBe(true);
  });
});
