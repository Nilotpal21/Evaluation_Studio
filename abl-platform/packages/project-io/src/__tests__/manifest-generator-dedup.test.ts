import { describe, it, expect } from 'vitest';
import { generateManifest, generateManifestV2 } from '../export/manifest-generator.js';

const baseInput = {
  projectName: 'Test',
  projectSlug: 'test',
  projectDescription: null,
  exportedBy: 'user-1',
  entryAgent: null,
  tools: [],
  edges: [],
};

describe('generateManifest duplicate detection', () => {
  it('should throw when agents have duplicate names', () => {
    expect(() =>
      generateManifest({
        ...baseInput,
        agents: [
          { name: 'Booking', description: null, ownerId: null, ownerTeamId: null, version: null },
          { name: 'Booking', description: 'dup', ownerId: null, ownerTeamId: null, version: null },
        ],
      }),
    ).toThrow(/Duplicate agent name.*Booking/);
  });

  it('should not throw for unique agent names', () => {
    expect(() =>
      generateManifest({
        ...baseInput,
        agents: [
          { name: 'AgentA', description: null, ownerId: null, ownerTeamId: null, version: null },
          { name: 'AgentB', description: null, ownerId: null, ownerTeamId: null, version: null },
        ],
      }),
    ).not.toThrow();
  });
});

describe('generateManifestV2 duplicate detection', () => {
  it('should throw when agents have duplicate names', () => {
    expect(() =>
      generateManifestV2({
        ...baseInput,
        agents: [
          { name: 'Booking', description: null, ownerId: null, ownerTeamId: null, version: null },
          { name: 'Booking', description: 'dup', ownerId: null, ownerTeamId: null, version: null },
        ],
        layers: ['core'],
        entityCounts: {},
        requiredEnvVars: [],
        requiredConnectors: [],
        requiredMcpServers: [],
      }),
    ).toThrow(/Duplicate agent name.*Booking/);
  });
});
