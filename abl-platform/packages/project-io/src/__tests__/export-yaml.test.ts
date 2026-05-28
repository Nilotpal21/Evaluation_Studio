import { describe, it, expect } from 'vitest';
import { exportProject, type ProjectData } from '../export/project-exporter.js';
import type { ExportOptions } from '../types.js';

function makeProject(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    name: 'Test Project',
    slug: 'test-project',
    description: 'A test project',
    entryAgentName: null,
    agents: [
      {
        name: 'booking_agent',
        description: 'Books hotels',
        dslContent: 'agent: booking_agent\nmode: reasoning\ngoal: Help book hotels',
        ownerId: null,
        ownerTeamId: null,
        version: '1.0.0',
        status: 'active',
      },
    ],
    toolFiles: [],
    deployments: [],
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    projectId: 'proj_123',
    userId: 'user_1',
    tenantId: 'tenant_1',
    format: 'folder',
    ...overrides,
  };
}

describe('exportProject with dslFormat', () => {
  it('uses .agent.yaml extension by default', () => {
    const result = exportProject(makeProject(), makeOptions());
    expect(result.success).toBe(true);
    const paths = [...result.files.keys()];
    expect(paths.some((p) => p.endsWith('.agent.yaml'))).toBe(true);
  });

  it('preserves legacy source DSL and file extension by default', () => {
    const legacyDsl = 'AGENT: BookingAgent\nGOAL: "Help book hotels"\n';
    const result = exportProject(
      makeProject({
        entryAgentName: 'BookingAgent',
        agents: [
          {
            name: 'BookingAgent',
            description: 'Books hotels',
            dslContent: legacyDsl,
            ownerId: null,
            ownerTeamId: null,
            version: '1.0.0',
            status: 'active',
          },
        ],
      }),
      makeOptions(),
    );

    expect(result.success).toBe(true);
    expect(result.files.get('agents/bookingagent.agent.abl')).toBe(legacyDsl);
    expect(result.manifest.dsl_format).toBe('legacy');
  });

  it('uses .agent.yaml extension when dslFormat is yaml', () => {
    const result = exportProject(
      makeProject(),
      makeOptions({
        dslFormat: 'yaml',
        compileFn: () => ({
          metadata: { name: 'booking_agent', type: 'agent' },
          execution: { mode: 'reasoning' },
          identity: { goal: 'Help book hotels' },
          tools: [],
          gather: { fields: [] },
          memory: {},
          constraints: { constraints: [], guardrails: [] },
          coordination: { handoffs: [], delegates: [], escalation: {} },
          completion: {},
          error_handling: {},
        }),
      }),
    );
    expect(result.success).toBe(true);
    const paths = [...result.files.keys()];
    expect(paths.some((p) => p.endsWith('.agent.yaml'))).toBe(true);
  });

  it('keeps original DSL when compileFn returns null', () => {
    const result = exportProject(
      makeProject(),
      makeOptions({
        dslFormat: 'yaml',
        compileFn: () => null,
      }),
    );
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('Failed to compile'))).toBe(true);
    // File should still be created with original DSL
    const agentFile = [...result.files.entries()].find(([p]) => p.includes('booking_agent'));
    expect(agentFile).toBeDefined();
    expect(agentFile![1]).toContain('agent: booking_agent');
  });

  it('keeps truthful source extension when dslFormat is yaml but no compileFn', () => {
    const result = exportProject(
      makeProject({
        agents: [
          {
            name: 'BookingAgent',
            description: 'Books hotels',
            dslContent: 'AGENT: BookingAgent\nGOAL: "Help book hotels"\n',
            ownerId: null,
            ownerTeamId: null,
            version: '1.0.0',
            status: 'active',
          },
        ],
      }),
      makeOptions({ dslFormat: 'yaml' }),
    );

    expect(result.success).toBe(true);
    const paths = [...result.files.keys()];
    expect(paths.some((p) => p.endsWith('.agent.abl'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.agent.yaml'))).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Requested YAML export for agent "BookingAgent" without compiler context',
        ),
      ]),
    );
    expect(result.manifest.dsl_format).toBe('legacy');
  });

  it('includes dsl_format in manifest', () => {
    const result = exportProject(makeProject(), makeOptions({ dslFormat: 'yaml' }));
    expect(result.success).toBe(true);
    expect(result.manifest.dsl_format).toBe('yaml');
  });

  it('defaults dsl_format to yaml in manifest', () => {
    const result = exportProject(makeProject(), makeOptions());
    expect(result.success).toBe(true);
    expect(result.manifest.dsl_format).toBe('yaml');
  });

  it('detects supervisor in YAML format', () => {
    const result = exportProject(
      makeProject({
        agents: [
          {
            name: 'main_supervisor',
            description: 'Routes things',
            dslContent: 'supervisor: main_supervisor\nmode: supervisor\ngoal: Route',
            ownerId: null,
            ownerTeamId: null,
            version: '1.0.0',
            status: 'active',
          },
        ],
      }),
      makeOptions(),
    );
    expect(result.success).toBe(true);
    expect(result.manifest.entry_agent).toBe('main_supervisor');
  });
});
