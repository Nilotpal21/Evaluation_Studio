import { describe, it, expect } from 'vitest';
import { profileFilePath, buildFileMap, type AgentFileEntry } from '../export/folder-builder.js';
import { generateManifest, type ManifestInput } from '../export/manifest-generator.js';
import type { ToolFileEntry, DependencyEdge } from '../types.js';

// ─── profileFilePath ─────────────────────────────────────────────────────────

describe('profileFilePath', () => {
  it('should normalize profile names to lowercase with underscores', () => {
    expect(profileFilePath('MyProfile')).toBe('behavior_profiles/myprofile.behavior_profile.abl');
  });

  it('should replace special characters with underscores', () => {
    expect(profileFilePath('My Profile!')).toBe(
      'behavior_profiles/my_profile_.behavior_profile.abl',
    );
  });

  it('should replace hyphens with underscores', () => {
    expect(profileFilePath('formal-tone')).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
  });

  it('should handle names with numbers', () => {
    expect(profileFilePath('Profile123')).toBe('behavior_profiles/profile123.behavior_profile.abl');
  });

  it('should handle names that are already normalized', () => {
    expect(profileFilePath('simple_profile')).toBe(
      'behavior_profiles/simple_profile.behavior_profile.abl',
    );
  });

  it('should handle empty string', () => {
    expect(profileFilePath('')).toBe('behavior_profiles/.behavior_profile.abl');
  });
});

// ─── buildFileMap with profiles ──────────────────────────────────────────────

describe('buildFileMap with profiles', () => {
  it('should include profile files when profiles are provided', () => {
    const agents: AgentFileEntry[] = [
      { name: 'Main', dslContent: 'SUPERVISOR: Main', isSupervisor: true },
    ];
    const profiles = new Map([
      ['formal_tone', 'BEHAVIOR_PROFILE: formal_tone\nPRIORITY: 10'],
      ['concise_style', 'BEHAVIOR_PROFILE: concise_style\nPRIORITY: 5'],
    ]);

    const result = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

    expect(result.has('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(true);
    expect(result.has('behavior_profiles/concise_style.behavior_profile.abl')).toBe(true);
    expect(result.get('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(
      'BEHAVIOR_PROFILE: formal_tone\nPRIORITY: 10',
    );
  });

  it('should not include behavior_profiles directory when profiles are undefined', () => {
    const agents: AgentFileEntry[] = [
      { name: 'Main', dslContent: 'SUPERVISOR: Main', isSupervisor: true },
    ];

    const result = buildFileMap(agents, [], new Map(), new Map());

    const hasBehaviorProfile = [...result.keys()].some((k) => k.startsWith('behavior_profiles/'));
    expect(hasBehaviorProfile).toBe(false);
  });

  it('should not include behavior_profiles directory when profiles map is empty', () => {
    const agents: AgentFileEntry[] = [
      { name: 'Main', dslContent: 'SUPERVISOR: Main', isSupervisor: true },
    ];

    const result = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', new Map());

    const hasBehaviorProfile = [...result.keys()].some((k) => k.startsWith('behavior_profiles/'));
    expect(hasBehaviorProfile).toBe(false);
  });

  it('should combine profiles with agents, tools, configs, and deployments', () => {
    const agents: AgentFileEntry[] = [
      { name: 'Main', dslContent: 'SUPERVISOR: Main', isSupervisor: true },
    ];
    const tools: ToolFileEntry[] = [{ name: 'hotels-api', content: 'TOOL: hotels-api' }];
    const configs = new Map([['models.json', '{}']]);
    const deployments = new Map([['dev.deployment.json', '{}']]);
    const profiles = new Map([['formal_tone', 'BEHAVIOR_PROFILE: formal_tone']]);

    const result = buildFileMap(agents, tools, configs, deployments, undefined, 'yaml', profiles);

    expect(result.has('agents/main.agent.yaml')).toBe(true);
    expect(result.has('tools/hotels-api.tools.abl')).toBe(true);
    expect(result.has('config/models.json')).toBe(true);
    expect(result.has('deployments/dev.deployment.json')).toBe(true);
    expect(result.has('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(true);
  });

  it('should normalize profile names in file paths', () => {
    const profiles = new Map([['Formal Tone', 'BEHAVIOR_PROFILE: Formal_Tone']]);

    const result = buildFileMap([], [], new Map(), new Map(), undefined, 'yaml', profiles);

    expect(result.has('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(true);
  });

  it('should suffix colliding normalized profile names instead of overwriting the first file', () => {
    const profiles = new Map([
      ['Formal-Tone', 'BEHAVIOR_PROFILE: Formal-Tone\nPRIORITY: 10'],
      ['formal_tone', 'BEHAVIOR_PROFILE: formal_tone\nPRIORITY: 5'],
    ]);

    const result = buildFileMap([], [], new Map(), new Map(), undefined, 'yaml', profiles);

    expect(result.has('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(true);
    expect(result.has('behavior_profiles/formal_tone_2.behavior_profile.abl')).toBe(true);
    expect(result.get('behavior_profiles/formal_tone.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: Formal-Tone',
    );
    expect(result.get('behavior_profiles/formal_tone_2.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: formal_tone',
    );
  });
});

// ─── Manifest with profiles ─────────────────────────────────────────────────

describe('manifest-generator with profiles', () => {
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

  it('should include behavior_profiles when profiles are provided', () => {
    const manifest = generateManifest(
      makeInput({
        profiles: [
          {
            name: 'formal_tone',
            priority: 10,
            whenSummary: 'channel == "email"',
            usedBy: ['Main'],
          },
        ],
      }),
    );

    expect(manifest.behavior_profiles).toBeDefined();
    expect(manifest.behavior_profiles!['formal_tone']).toEqual({
      name: 'formal_tone',
      path: 'behavior_profiles/formal_tone.behavior_profile.abl',
      priority: 10,
      when_summary: 'channel == "email"',
      used_by: ['Main'],
    });
  });

  it('should not include behavior_profiles when profiles are not provided', () => {
    const manifest = generateManifest(makeInput());
    expect(manifest.behavior_profiles).toBeUndefined();
  });

  it('should not include behavior_profiles when profiles array is empty', () => {
    const manifest = generateManifest(makeInput({ profiles: [] }));
    expect(manifest.behavior_profiles).toBeUndefined();
  });

  it('should include multiple profiles', () => {
    const manifest = generateManifest(
      makeInput({
        profiles: [
          {
            name: 'formal_tone',
            priority: 10,
            whenSummary: 'channel == "email"',
            usedBy: ['Main'],
          },
          {
            name: 'concise_style',
            priority: 5,
            whenSummary: 'channel == "sms"',
            usedBy: ['Main', 'Worker'],
          },
        ],
      }),
    );

    expect(manifest.behavior_profiles).toBeDefined();
    expect(Object.keys(manifest.behavior_profiles!)).toHaveLength(2);
    expect(manifest.behavior_profiles!['formal_tone'].priority).toBe(10);
    expect(manifest.behavior_profiles!['concise_style'].used_by).toEqual(['Main', 'Worker']);
  });

  it('should generate correct file paths for profile names', () => {
    const manifest = generateManifest(
      makeInput({
        profiles: [
          {
            name: 'Formal Tone',
            priority: 10,
            whenSummary: 'always',
            usedBy: [],
          },
        ],
      }),
    );

    expect(manifest.behavior_profiles!['Formal Tone'].path).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
  });

  it('should suffix colliding normalized profile paths in the manifest', () => {
    const manifest = generateManifest(
      makeInput({
        profiles: [
          {
            name: 'Formal-Tone',
            priority: 10,
            whenSummary: 'channel == "email"',
            usedBy: ['Main'],
          },
          {
            name: 'formal_tone',
            priority: 5,
            whenSummary: 'channel == "sms"',
            usedBy: ['Main'],
          },
        ],
      }),
    );

    expect(manifest.behavior_profiles!['Formal-Tone'].path).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(manifest.behavior_profiles!['formal_tone'].path).toBe(
      'behavior_profiles/formal_tone_2.behavior_profile.abl',
    );
  });

  it('should use provided profile paths when callers materialize collisions upstream', () => {
    const manifest = generateManifest(
      makeInput({
        profiles: [
          {
            name: 'Formal-Tone',
            priority: 10,
            whenSummary: 'channel == "email"',
            usedBy: ['Main'],
          },
          {
            name: 'formal_tone',
            priority: 5,
            whenSummary: 'channel == "sms"',
            usedBy: ['Main'],
          },
        ],
        profilePaths: {
          'Formal-Tone': 'behavior_profiles/formal_tone.behavior_profile.abl',
          formal_tone: 'behavior_profiles/formal_tone_2.behavior_profile.abl',
        },
      }),
    );

    expect(manifest.behavior_profiles!['Formal-Tone'].path).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(manifest.behavior_profiles!['formal_tone'].path).toBe(
      'behavior_profiles/formal_tone_2.behavior_profile.abl',
    );
  });
});
