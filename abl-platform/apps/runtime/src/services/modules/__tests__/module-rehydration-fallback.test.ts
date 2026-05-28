/**
 * Module Rehydration Fallback Tests
 *
 * Validates that resolveModuleAgentIR correctly resolves an agent IR
 * from module dependencies when the agent name contains '__' (indicating
 * a module-prefixed agent like "payments__main").
 *
 * Issue: After runtime restart, rehydration tries to find module agent IR
 * in the project DB, but module agents don't exist there. We need a fallback
 * that loads the IR from the module release via ProjectModuleDependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { resolveModuleAgentIR } from '../module-rehydration-fallback.js';

describe('resolveModuleAgentIR', () => {
  const mockModuleFind = vi.fn();
  const mockModuleLean = vi.fn();
  const mockReleaseFind = vi.fn();
  const mockReleaseLean = vi.fn();
  const models = {
    ProjectModuleDependency: {
      find: mockModuleFind,
    },
    ModuleRelease: {
      findOne: mockReleaseFind,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockModuleFind.mockReturnValue({ lean: mockModuleLean });
    mockReleaseFind.mockReturnValue({ lean: mockReleaseLean });
  });

  it('should return null for non-module agent names (no __)', async () => {
    const result = await resolveModuleAgentIR('local_agent', 'tenant1', 'proj1', models);
    expect(result).toBeNull();
    expect(mockModuleFind).not.toHaveBeenCalled();
  });

  it('should resolve agent IR from module release for module agent name', async () => {
    const fakeIR = {
      metadata: { name: 'main', version: '1.0' },
      execution: { mode: 'reasoning' },
    };

    mockModuleLean.mockResolvedValue([
      {
        _id: 'dep1',
        alias: 'payments',
        moduleProjectId: 'mod-proj-1',
        resolvedReleaseId: 'rel1',
      },
    ]);

    mockReleaseLean.mockResolvedValue({
      _id: 'rel1',
      compiledIR: { main: fakeIR },
      artifact: {
        agents: { main: { name: 'main' } },
        tools: {},
      },
    });

    const result = await resolveModuleAgentIR('payments__main', 'tenant1', 'proj1', models);

    expect(result).not.toBeNull();
    expect(result?.agentIR).toBeDefined();
    // The rewritten agent should have the aliased name
    expect(result?.agentIR.metadata.name).toBe('payments__main');
    expect(mockReleaseFind).toHaveBeenCalledWith({
      _id: 'rel1',
      tenantId: 'tenant1',
      moduleProjectId: 'mod-proj-1',
      archivedAt: { $in: [null, undefined] },
    });
  });

  it('should return null when no module dependency matches the alias', async () => {
    mockModuleLean.mockResolvedValue([
      {
        _id: 'dep1',
        alias: 'crm',
        moduleProjectId: 'mod-proj-1',
        resolvedReleaseId: 'rel1',
      },
    ]);

    // "payments" alias doesn't match any dependency
    const result = await resolveModuleAgentIR('payments__main', 'tenant1', 'proj1', models);
    expect(result).toBeNull();
    expect(mockReleaseFind).not.toHaveBeenCalled();
  });

  it('should return null when module release is not found', async () => {
    mockModuleLean.mockResolvedValue([
      {
        _id: 'dep1',
        alias: 'payments',
        moduleProjectId: 'mod-proj-1',
        resolvedReleaseId: 'rel1',
      },
    ]);

    mockReleaseLean.mockResolvedValue(null);

    const result = await resolveModuleAgentIR('payments__main', 'tenant1', 'proj1', models);
    expect(result).toBeNull();
  });

  it('should return null when agent name not found in module compiled IR', async () => {
    mockModuleLean.mockResolvedValue([
      {
        _id: 'dep1',
        alias: 'payments',
        moduleProjectId: 'mod-proj-1',
        resolvedReleaseId: 'rel1',
      },
    ]);

    mockReleaseLean.mockResolvedValue({
      _id: 'rel1',
      compiledIR: { other_agent: { metadata: { name: 'other_agent' } } },
      artifact: { agents: { other_agent: {} }, tools: {} },
    });

    // "main" doesn't exist in the module's compiled IR
    const result = await resolveModuleAgentIR('payments__main', 'tenant1', 'proj1', models);
    expect(result).toBeNull();
  });

  it('should handle errors gracefully and return null', async () => {
    mockModuleLean.mockRejectedValue(new Error('DB connection failed'));

    const result = await resolveModuleAgentIR('payments__main', 'tenant1', 'proj1', models);
    expect(result).toBeNull();
  });
});
