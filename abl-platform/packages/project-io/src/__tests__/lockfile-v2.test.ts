/**
 * Tests for lockfile generator v2 — 3-tier SHA verification
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  generateLockfileV2,
  verifyLockfileV2Integrity,
  computeSourceHash,
  computeLayerHash,
} from '../export/lockfile-generator.js';
import type { LayerName } from '../types.js';

function makeLayerFiles(
  entries: Array<[LayerName, Array<[string, string]>]>,
): Map<LayerName, Map<string, string>> {
  const result = new Map<LayerName, Map<string, string>>();
  for (const [layer, files] of entries) {
    result.set(layer, new Map(files));
  }
  return result;
}

function computeLegacyIntegrityWithoutBehaviorProfiles(
  lockfile: ReturnType<typeof generateLockfileV2>,
): string {
  const sortRecord = (obj: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  const integrityPayload = JSON.stringify({
    agents: sortRecord(lockfile.agents),
    tools: sortRecord(lockfile.tools),
    configs: sortRecord(lockfile.configs),
    connections: sortRecord(lockfile.connections),
    guardrails: sortRecord(lockfile.guardrails),
    workflows: sortRecord(lockfile.workflows),
    evals: sortRecord(lockfile.evals),
    search: sortRecord(lockfile.search),
    channels: sortRecord(lockfile.channels),
    vocabulary: sortRecord(lockfile.vocabulary),
    layer_hashes: sortRecord(lockfile.layer_hashes as Record<string, string>),
  });
  return createHash('sha256').update(integrityPayload, 'utf8').digest('hex');
}

describe('generateLockfileV2', () => {
  it('should produce lockfile_version 2.0', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.lockfile_version).toBe('2.0');
    expect(lockfile.generated_at).toBeTruthy();
  });

  it('should compute per-file source hashes for agents', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.agents['Main']).toBeDefined();
    expect(lockfile.agents['Main'].source_hash).toBe(computeSourceHash('AGENT: Main'));
    expect(lockfile.agents['Main'].version).toBe('1.0');
    expect(lockfile.agents['Main'].status).toBe('active');
  });

  it('should keep v2 agent source_hash truncated while reflecting prompt companion changes', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const baseAgent = { name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' };

    const withoutPromptRef = generateLockfileV2(layerFiles, [baseAgent]);
    const withPromptRef = generateLockfileV2(layerFiles, [
      {
        ...baseAgent,
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'prompt-hash-1',
        },
      },
    ]);

    expect(withoutPromptRef.agents['Main'].source_hash).toHaveLength(16);
    expect(withPromptRef.agents['Main'].source_hash).toHaveLength(16);
    expect(withPromptRef.agents['Main'].source_hash).not.toBe(
      withoutPromptRef.agents['Main'].source_hash,
    );
  });

  it('should compute per-file hashes for non-agent layer files', () => {
    const layerFiles = makeLayerFiles([
      ['core', [['agents/main.agent.abl', 'AGENT: Main']]],
      [
        'connections',
        [['connections/connectors/salesforce.connection.json', '{"type":"salesforce"}']],
      ],
      ['guardrails', [['guardrails/pii-filter.guardrail.json', '{"type":"pii"}']]],
    ]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.connections['connections/connectors/salesforce.connection.json']).toBeDefined();
    expect(
      lockfile.connections['connections/connectors/salesforce.connection.json'].source_hash,
    ).toBe(computeSourceHash('{"type":"salesforce"}'));
    expect(lockfile.guardrails['guardrails/pii-filter.guardrail.json']).toBeDefined();
  });

  it('should compute per-layer composite hashes', () => {
    const layerFiles = makeLayerFiles([
      [
        'core',
        [
          ['agents/main.agent.abl', 'AGENT: Main'],
          ['agents/helper.agent.abl', 'AGENT: Helper'],
        ],
      ],
      ['connections', [['connections/connectors/db.connection.json', '{"type":"db"}']]],
    ]);
    const agents = [
      { name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' },
      { name: 'Helper', version: '1.0', dslContent: 'AGENT: Helper', status: 'active' },
    ];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.layer_hashes.core).toBeTruthy();
    expect(lockfile.layer_hashes.connections).toBeTruthy();
    expect(lockfile.layer_hashes.guardrails).toBeUndefined();
  });

  it('should compute root integrity hash', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.integrity).toBeTruthy();
    expect(lockfile.integrity.length).toBe(64); // Full SHA-256 hex
  });

  it('should populate tools from core layer tool files', () => {
    const layerFiles = makeLayerFiles([
      [
        'core',
        [
          ['agents/main.agent.abl', 'AGENT: Main'],
          ['tools/search.tools.abl', 'TOOL: Search'],
        ],
      ],
    ]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.tools['tools/search.tools.abl']).toBeDefined();
    expect(lockfile.tools['tools/search.tools.abl'].source_hash).toBe(
      computeSourceHash('TOOL: Search'),
    );
  });

  it('should populate config hashes from core layer config files', () => {
    const layerFiles = makeLayerFiles([
      [
        'core',
        [
          ['agents/main.agent.abl', 'AGENT: Main'],
          ['config/project-settings.json', '{"enableThinking":true}'],
        ],
      ],
    ]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.configs['config/project-settings.json']).toBeDefined();
  });

  it('should populate behavior profile hashes from core layer profile files', () => {
    const layerFiles = makeLayerFiles([
      [
        'core',
        [
          ['agents/main.agent.abl', 'AGENT: Main'],
          ['behavior_profiles/voice.profile.abl', 'BEHAVIOR_PROFILE: voice'],
        ],
      ],
    ]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(lockfile.behavior_profiles?.['behavior_profiles/voice.profile.abl']).toBeDefined();
    expect(lockfile.behavior_profiles?.['behavior_profiles/voice.profile.abl'].source_hash).toBe(
      computeSourceHash('BEHAVIOR_PROFILE: voice'),
    );
    expect(verifyLockfileV2Integrity(lockfile)).toBe(true);
  });

  it('should handle empty layer files map', () => {
    const layerFiles = new Map<LayerName, Map<string, string>>();
    const lockfile = generateLockfileV2(layerFiles, []);

    expect(lockfile.lockfile_version).toBe('2.0');
    expect(lockfile.integrity).toBeTruthy();
    expect(Object.keys(lockfile.agents)).toHaveLength(0);
  });
});

describe('verifyLockfileV2Integrity', () => {
  it('should return true for unmodified lockfile', () => {
    const layerFiles = makeLayerFiles([
      ['core', [['agents/main.agent.abl', 'AGENT: Main']]],
      ['connections', [['connections/connectors/db.json', '{"type":"db"}']]],
    ]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);

    expect(verifyLockfileV2Integrity(lockfile)).toBe(true);
  });

  it('should detect tampering of agent hash', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);
    lockfile.agents['Main'].source_hash = 'tampered_hash_val';

    expect(verifyLockfileV2Integrity(lockfile)).toBe(false);
  });

  it('should detect tampering of layer hash', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);
    lockfile.layer_hashes.core = 'tampered_layer_hash';

    expect(verifyLockfileV2Integrity(lockfile)).toBe(false);
  });

  it('should detect tampering of integrity hash', () => {
    const layerFiles = makeLayerFiles([['core', [['agents/main.agent.abl', 'AGENT: Main']]]]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);
    lockfile.integrity = 'tampered_integrity';

    expect(verifyLockfileV2Integrity(lockfile)).toBe(false);
  });

  it('should accept legacy lockfiles with behavior profile sections excluded from root integrity', () => {
    const layerFiles = makeLayerFiles([
      [
        'core',
        [
          ['agents/main.agent.abl', 'AGENT: Main'],
          ['behavior_profiles/voice.profile.abl', 'BEHAVIOR_PROFILE: voice'],
        ],
      ],
    ]);
    const agents = [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }];

    const lockfile = generateLockfileV2(layerFiles, agents);
    lockfile.integrity = computeLegacyIntegrityWithoutBehaviorProfiles(lockfile);

    expect(verifyLockfileV2Integrity(lockfile)).toBe(true);
  });
});

describe('computeLayerHash', () => {
  it('should produce deterministic hash regardless of insertion order', () => {
    const files1 = new Map([
      ['agents/a.abl', 'content-a'],
      ['agents/b.abl', 'content-b'],
    ]);
    const files2 = new Map([
      ['agents/b.abl', 'content-b'],
      ['agents/a.abl', 'content-a'],
    ]);

    expect(computeLayerHash(files1)).toBe(computeLayerHash(files2));
  });

  it('should differ when file content changes', () => {
    const files1 = new Map([['agents/a.abl', 'version-1']]);
    const files2 = new Map([['agents/a.abl', 'version-2']]);

    expect(computeLayerHash(files1)).not.toBe(computeLayerHash(files2));
  });
});
