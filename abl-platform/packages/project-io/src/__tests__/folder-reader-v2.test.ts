/**
 * Tests for Folder Reader v2 — v2 directory recognition and layer categorization
 */

import { describe, it, expect } from 'vitest';
import { readFolderV2, detectLayers } from '../import/folder-reader.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeV2Files(): Map<string, string> {
  const files = new Map<string, string>();

  // Manifest v2
  files.set(
    'project.json',
    JSON.stringify({
      format_version: '2.0',
      name: 'Test Project',
      slug: 'test-project',
      layers_included: ['core', 'connections', 'guardrails'],
    }),
  );

  // Lockfile v2
  files.set(
    'abl.lock',
    JSON.stringify({
      lockfile_version: '2.0',
      generated_at: '2026-03-07T10:00:00Z',
      agents: {},
      tools: {},
      integrity: 'abc123',
    }),
  );

  // Core layer
  files.set('agents/supervisor.agent.abl', 'AGENT: Supervisor\nGOAL: Route requests');
  files.set('agents/booking.agent.abl', 'AGENT: BookingAgent\nGOAL: Handle bookings');
  files.set('tools/hotels_api.tools.abl', 'TOOL: HotelsAPI\nENDPOINT: /api/hotels');
  files.set('config/project-settings.json', '{"enableThinking": true}');
  files.set('config/llm-config.json', '{"modelProvider": "openai"}');
  files.set('environment/env-vars.json', '[{"key": "OPENAI_API_KEY"}]');
  files.set(
    'behavior_profiles/formal_tone.behavior_profile.abl',
    'BEHAVIOR_PROFILE: formal_tone\nTONE: formal',
  );

  // Connections layer
  files.set(
    'connections/connectors/salesforce.connection.json',
    '{"name": "salesforce", "authType": "oauth2"}',
  );
  files.set(
    'core/mcp-servers/internal.mcp-config.json',
    '{"serverName": "internal", "endpoint": "http://localhost:8080"}',
  );

  // Guardrails layer
  files.set(
    'guardrails/input-filter.guardrail.json',
    '{"name": "input-filter", "providerType": "azure"}',
  );

  // Workflows layer
  files.set('workflows/escalation.workflow.json', '{"name": "escalation", "triggers": []}');

  // Evals layer
  files.set('evals/smoke-test/eval-set.json', '{"name": "smoke-test"}');
  files.set('evals/smoke-test/scenarios/happy-path.scenario.json', '{"name": "happy-path"}');
  files.set('evals/evaluators/tone.evaluator.json', '{"name": "tone"}');

  // Search layer
  files.set('search/indexes/products.search-index.json', '{"name": "products"}');
  files.set('search/sources/web.search-source.json', '{"name": "web"}');

  // Channels layer
  files.set('channels/slack.channel.json', '{"name": "slack"}');
  files.set('channels/webhooks/stripe.webhook.json', '{"name": "stripe"}');

  // Vocabulary layer
  files.set('vocabulary/domain-vocabulary.json', '{"entries": []}');
  files.set('vocabulary/lookup-tables/cities.lookup.json', '{"name": "cities"}');

  return files;
}

function makeV1Files(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(
    'project.json',
    JSON.stringify({
      name: 'V1 Project',
      slug: 'v1-project',
      version: '1.0',
      abl_version: '1.0',
    }),
  );
  files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Do stuff');
  files.set('tools/api.tools.abl', 'TOOL: API');
  return files;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('readFolderV2', () => {
  describe('v2 format detection', () => {
    it('should detect format_version 2.0', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.formatVersion).toBe('2.0');
    });

    it('should parse manifestV2', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.manifestV2).not.toBeNull();
      expect(result.manifestV2?.format_version).toBe('2.0');
      expect(result.manifestV2?.layers_included).toContain('core');
    });

    it('should parse lockfileV2', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.lockfileV2).not.toBeNull();
      expect(result.lockfileV2?.lockfile_version).toBe('2.0');
    });

    it('should categorize manifest-declared behavior profile paths', () => {
      const profilePath = 'behavior_profiles/formal_tone.profile.abl';
      const files = new Map<string, string>([
        [
          'project.json',
          JSON.stringify({
            format_version: '2.0',
            name: 'Test Project',
            slug: 'test-project',
            layers_included: ['core'],
            behavior_profiles: {
              formal_tone: {
                path: profilePath,
              },
            },
            metadata: {
              entity_counts: { core: 2, agents: 1, behavior_profiles: 1 },
            },
          }),
        ],
        ['agents/supervisor.agent.abl', 'AGENT: Supervisor\nGOAL: Route requests'],
        [profilePath, 'BEHAVIOR_PROFILE: formal_tone\nTONE: formal'],
      ]);

      const result = readFolderV2(files);

      expect(result.success).toBe(true);
      expect(result.profileFiles.get(profilePath)).toBe(
        'BEHAVIOR_PROFILE: formal_tone\nTONE: formal',
      );
      expect(result.layerFiles.core.has(profilePath)).toBe(true);
    });

    it('should reject invalid manifest-declared behavior profile paths without throwing', () => {
      const files = new Map<string, string>([
        [
          'project.json',
          JSON.stringify({
            format_version: '2.0',
            name: 'Test Project',
            slug: 'test-project',
            layers_included: ['core'],
            behavior_profiles: {
              missing_shape: null,
              bad_path: {
                path: 'behavior_profiles/README.md',
              },
            },
            metadata: {
              entity_counts: { core: 1, agents: 1 },
            },
          }),
        ],
        ['agents/supervisor.agent.abl', 'AGENT: Supervisor\nGOAL: Route requests'],
      ]);

      const result = readFolderV2(files);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Behavior profile "missing_shape" must declare a non-empty path'),
          expect.stringContaining('Behavior profile path "behavior_profiles/README.md" is invalid'),
        ]),
      );
    });

    it('should reject a malformed behavior_profiles manifest section', () => {
      const files = new Map<string, string>([
        [
          'project.json',
          JSON.stringify({
            format_version: '2.0',
            name: 'Test Project',
            slug: 'test-project',
            layers_included: ['core'],
            behavior_profiles: ['behavior_profiles/voice.profile.abl'],
            metadata: {
              entity_counts: { core: 1, behavior_profiles: 1 },
            },
          }),
        ],
        ['behavior_profiles/voice.profile.abl', 'BEHAVIOR_PROFILE: voice\nPRIORITY: 1\nWHEN: true'],
      ]);

      const result = readFolderV2(files);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('behavior_profiles must be an object')]),
      );
    });

    it('should reject duplicate behavior profile names before apply can collapse them', () => {
      const files = new Map<string, string>([
        [
          'project.json',
          JSON.stringify({
            format_version: '2.0',
            name: 'Test Project',
            slug: 'test-project',
            layers_included: ['core'],
            behavior_profiles: {
              voice_a: {
                path: 'behavior_profiles/voice_a.profile.abl',
              },
              voice_b: {
                path: 'behavior_profiles/voice_b.profile.abl',
              },
            },
            metadata: {
              entity_counts: { core: 2, behavior_profiles: 2 },
            },
          }),
        ],
        [
          'behavior_profiles/voice_a.profile.abl',
          'BEHAVIOR_PROFILE: voltmart_voice\nPRIORITY: 1\nWHEN: true',
        ],
        [
          'behavior_profiles/voice_b.profile.abl',
          'BEHAVIOR_PROFILE: voltmart_voice\nPRIORITY: 2\nWHEN: true',
        ],
      ]);

      const result = readFolderV2(files);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('duplicate entity name "voltmart_voice"')]),
      );
    });
  });

  describe('v1 fallback', () => {
    it('should detect v1 format when format_version is missing', () => {
      const result = readFolderV2(makeV1Files());
      expect(result.formatVersion).toBe('1.0');
      expect(result.manifestV2).toBeNull();
    });

    it('should generate warning for v1 format', () => {
      const result = readFolderV2(makeV1Files());
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('v1 format');
    });

    it('should still populate v1 fields correctly', () => {
      const result = readFolderV2(makeV1Files());
      expect(result.agentFiles.size).toBe(1);
      expect(result.toolFiles.size).toBe(1);
    });
  });

  describe('layer categorization', () => {
    it('should categorize core layer files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.agentFiles.size).toBe(2);
      expect(result.toolFiles.size).toBe(1);
      expect(result.configFiles.size).toBe(3);
      expect(result.profileFiles.size).toBe(1);
      expect(result.environmentFiles.size).toBe(1);
    });

    it('should categorize connection files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.connectionFiles.size).toBe(1);
      expect(result.connectionFiles.has('connections/connectors/salesforce.connection.json')).toBe(
        true,
      );
    });

    it('should categorize guardrail files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.guardrailFiles.size).toBe(1);
    });

    it('should categorize YAML guardrail files and ignore unrelated guardrail assets', () => {
      const files = makeV2Files();
      files.delete('guardrails/input-filter.guardrail.json');
      files.set('guardrails/input-filter.guardrail.yaml', 'name: input-filter');
      files.set('guardrails/README.md', '# notes');

      const result = readFolderV2(files);

      expect(result.guardrailFiles.size).toBe(1);
      expect(result.guardrailFiles.has('guardrails/input-filter.guardrail.yaml')).toBe(true);
      expect(result.guardrailFiles.has('guardrails/README.md')).toBe(false);
    });

    it('should categorize workflow files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.workflowFiles.size).toBe(1);
    });

    it('should categorize eval files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.evalFiles.size).toBe(3);
    });

    it('should categorize search files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.searchFiles.size).toBe(2);
    });

    it('should categorize channel files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.channelFiles.size).toBe(2);
    });

    it('should categorize vocabulary files', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.vocabularyFiles.size).toBe(2);
    });
  });

  describe('layerFiles aggregation', () => {
    it('should aggregate core layer from agents, tools, config, profiles, environment', () => {
      const result = readFolderV2(makeV2Files());
      const coreFiles = result.layerFiles.core;

      // agents (2) + tools (1) + config (2) + core/mcp-servers (1) + profiles (1) + environment (1)
      expect(coreFiles.size).toBe(8);
    });

    it('should map connection files to connections layer', () => {
      const result = readFolderV2(makeV2Files());
      expect(result.layerFiles.connections).toBe(result.connectionFiles);
    });
  });
});

describe('detectLayers', () => {
  it('should detect all layers present in v2 export', () => {
    const result = readFolderV2(makeV2Files());
    const layers = detectLayers(result);

    expect(layers).toContain('core');
    expect(layers).toContain('connections');
    expect(layers).toContain('guardrails');
    expect(layers).toContain('workflows');
    expect(layers).toContain('evals');
    expect(layers).toContain('search');
    expect(layers).toContain('channels');
    expect(layers).toContain('vocabulary');
    expect(layers.length).toBe(8);
  });

  it('should detect only core for v1 export', () => {
    const result = readFolderV2(makeV1Files());
    const layers = detectLayers(result);

    expect(layers).toEqual(['core']);
  });

  it('should not include empty layers', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main');
    files.set('guardrails/policy.guardrail.json', '{}');

    const result = readFolderV2(files);
    const layers = detectLayers(result);

    expect(layers).toContain('core');
    expect(layers).toContain('guardrails');
    expect(layers).not.toContain('connections');
    expect(layers).not.toContain('workflows');
  });
});
