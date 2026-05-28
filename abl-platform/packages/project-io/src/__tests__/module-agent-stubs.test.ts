import { describe, it, expect } from 'vitest';
import {
  buildModuleAgentStubs,
  isMountedModuleName,
  MODULE_NAME_SEPARATOR,
  type ModuleDependencyRecord,
} from '../module-release/module-agent-stubs';

describe('buildModuleAgentStubs', () => {
  it('should create stubs for each provided agent with mounted names', () => {
    const deps: ModuleDependencyRecord[] = [
      {
        alias: 'benefits',
        contractSnapshot: {
          providedAgents: [{ name: 'lookup' }, { name: 'triage' }],
        },
      },
    ];
    const stubs = buildModuleAgentStubs(deps);
    expect(stubs).toHaveLength(2);
    expect(stubs[0].name).toBe('benefits__lookup');
    expect(stubs[1].name).toBe('benefits__triage');
  });

  it('should skip dependencies with null contractSnapshot', () => {
    const deps: ModuleDependencyRecord[] = [{ alias: 'broken', contractSnapshot: null }];
    expect(buildModuleAgentStubs(deps)).toHaveLength(0);
  });

  it('should skip dependencies with no providedAgents', () => {
    const deps: ModuleDependencyRecord[] = [
      { alias: 'empty', contractSnapshot: { providedAgents: [] } },
    ];
    expect(buildModuleAgentStubs(deps)).toHaveLength(0);
  });

  it('should skip names already in existingNames set', () => {
    const deps: ModuleDependencyRecord[] = [
      {
        alias: 'mod',
        contractSnapshot: {
          providedAgents: [{ name: 'agent1' }, { name: 'agent2' }],
        },
      },
    ];
    const existing = ['mod__agent1'];
    const stubs = buildModuleAgentStubs(deps, existing);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].name).toBe('mod__agent2');
  });

  it('should handle multiple dependencies', () => {
    const deps: ModuleDependencyRecord[] = [
      { alias: 'a', contractSnapshot: { providedAgents: [{ name: 'x' }] } },
      { alias: 'b', contractSnapshot: { providedAgents: [{ name: 'y' }] } },
    ];
    const stubs = buildModuleAgentStubs(deps);
    expect(stubs).toHaveLength(2);
    expect(stubs.map((s) => s.name)).toEqual(['a__x', 'b__y']);
  });

  it('should deduplicate across dependencies', () => {
    const deps: ModuleDependencyRecord[] = [
      { alias: 'mod', contractSnapshot: { providedAgents: [{ name: 'agent1' }] } },
      { alias: 'mod', contractSnapshot: { providedAgents: [{ name: 'agent1' }] } },
    ];
    const stubs = buildModuleAgentStubs(deps);
    expect(stubs).toHaveLength(1);
  });

  it('should skip empty alias', () => {
    const deps: ModuleDependencyRecord[] = [
      { alias: '', contractSnapshot: { providedAgents: [{ name: 'agent1' }] } },
    ];
    expect(buildModuleAgentStubs(deps)).toHaveLength(0);
  });

  it('should skip agents with empty name', () => {
    const deps: ModuleDependencyRecord[] = [
      {
        alias: 'mod',
        contractSnapshot: {
          providedAgents: [{ name: '' }, { name: 'valid' }],
        },
      },
    ];
    const stubs = buildModuleAgentStubs(deps);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].name).toBe('mod__valid');
  });

  it('should skip dependencies with undefined contractSnapshot', () => {
    const deps: ModuleDependencyRecord[] = [{ alias: 'nocontract' }];
    expect(buildModuleAgentStubs(deps)).toHaveLength(0);
  });
});

describe('isMountedModuleName', () => {
  it('should return true for mounted module names', () => {
    expect(isMountedModuleName('benefits__lookup')).toBe(true);
  });

  it('should return false for regular agent names', () => {
    expect(isMountedModuleName('lookup')).toBe(false);
  });
});

describe('MODULE_NAME_SEPARATOR', () => {
  it('should be double underscore', () => {
    expect(MODULE_NAME_SEPARATOR).toBe('__');
  });
});
