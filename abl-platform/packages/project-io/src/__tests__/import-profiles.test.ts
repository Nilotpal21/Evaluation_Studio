import { describe, it, expect } from 'vitest';
import { readFolder } from '../import/folder-reader.js';
import { extractDependencies } from '../dependencies/dependency-extractor.js';
import { importProject, type ExistingProjectState } from '../import/project-importer.js';
import type { ImportOptions } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_A = `AGENT: AgentA
VERSION: "1.0"

GOAL: "Do A"
COMPLETE:
  - WHEN: true
    RESPOND: "Done A"`;

const PROFILE_FORMAL = `BEHAVIOR_PROFILE: formal_tone
PRIORITY: 10
WHEN:
  channel == "email"

PERSONA:
  TONE: formal
  STYLE: professional`;

const PROFILE_CONCISE = `BEHAVIOR_PROFILE: concise_style
PRIORITY: 5
WHEN:
  channel == "sms"

PERSONA:
  TONE: brief
  STYLE: concise`;

const PROFILE_MODIFIED = `BEHAVIOR_PROFILE: formal_tone
PRIORITY: 20
WHEN:
  channel == "email" || channel == "slack"

PERSONA:
  TONE: formal
  STYLE: professional and detailed`;

const AGENT_WITH_PROFILE = `AGENT: StyledAgent
VERSION: "1.0"

GOAL: "Respond with style"

USE BEHAVIOR_PROFILE: formal_tone

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

const AGENT_WITH_MULTIPLE_PROFILES = `AGENT: MultiStyleAgent
VERSION: "1.0"

GOAL: "Respond with multiple styles"

USE BEHAVIOR_PROFILE: formal_tone
USE BEHAVIOR_PROFILE: concise_style

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

const AGENT_WITH_HYPHENATED_PROFILE = `AGENT: VoiceAgent
VERSION: "1.0"

GOAL: "Respond in voice mode"

USE BEHAVIOR_PROFILE: voice-optimized

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

function makeImportOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    files: new Map(),
    ...overrides,
  };
}

// ─── readFolder: profile file categorization ─────────────────────────────────

describe('readFolder profile categorization', () => {
  it('should categorize .behavior_profile.abl files into profileFiles', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main');
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL);
    files.set('behavior_profiles/concise_style.behavior_profile.abl', PROFILE_CONCISE);

    const result = readFolder(files);

    expect(result.success).toBe(true);
    expect(result.profileFiles.size).toBe(2);
    expect(result.profileFiles.has('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(
      true,
    );
    expect(result.profileFiles.has('behavior_profiles/concise_style.behavior_profile.abl')).toBe(
      true,
    );
    expect(result.profileFiles.get('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(
      PROFILE_FORMAL,
    );
  });

  it('should ignore non-profile files in behavior_profiles/ directory', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main');
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL);
    files.set('behavior_profiles/README.md', '# Profiles documentation');
    files.set('behavior_profiles/notes.txt', 'some notes');

    const result = readFolder(files);

    expect(result.profileFiles.size).toBe(1);
    expect(result.profileFiles.has('behavior_profiles/formal_tone.behavior_profile.abl')).toBe(
      true,
    );
  });

  it('should return empty profileFiles when no profiles exist', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main');

    const result = readFolder(files);

    expect(result.profileFiles.size).toBe(0);
  });

  it('should not categorize .behavior_profile.abl files outside behavior_profiles/ directory', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main');
    files.set('agents/formal_tone.behavior_profile.abl', PROFILE_FORMAL);

    const result = readFolder(files);

    expect(result.profileFiles.size).toBe(0);
    // It should also not be in agentFiles since .behavior_profile.abl != .agent.abl
    expect(result.agentFiles.size).toBe(1);
  });

  it('should categorize profiles alongside agents, tools, and locales', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main');
    files.set('tools/api.tools.abl', 'TOOL: api');
    files.set('locales/en/main.json', '{"greeting": "Hello"}');
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL);

    const result = readFolder(files);

    expect(result.success).toBe(true);
    expect(result.agentFiles.size).toBe(1);
    expect(result.toolFiles.size).toBe(1);
    expect(result.localeFiles.size).toBe(1);
    expect(result.profileFiles.size).toBe(1);
  });

  it('should categorize v2 manifest-declared .profile.abl files without exposing a v2 manifest as v1', () => {
    const files = new Map<string, string>();
    files.set(
      'project.json',
      JSON.stringify({
        format_version: '2.0',
        layers_included: ['core'],
        behavior_profiles: {
          formal_tone: {
            path: 'behavior_profiles/formal_tone.profile.abl',
          },
        },
      }),
    );
    files.set('agents/main.agent.abl', 'AGENT: Main');
    files.set('behavior_profiles/formal_tone.profile.abl', PROFILE_FORMAL);

    const result = readFolder(files);

    expect(result.success).toBe(true);
    expect(result.manifest).toBeNull();
    expect(result.profileFiles.get('behavior_profiles/formal_tone.profile.abl')).toBe(
      PROFILE_FORMAL,
    );
  });
});

// ─── extractDependencies: USE BEHAVIOR_PROFILE detection ─────────────────────

describe('extractDependencies profile references', () => {
  it('should detect USE BEHAVIOR_PROFILE: references', () => {
    const deps = extractDependencies(AGENT_WITH_PROFILE);
    const profileDeps = deps.filter((d) => d.type === 'profile_use');

    expect(profileDeps).toHaveLength(1);
    expect(profileDeps[0].targetAgent).toBe('formal_tone');
    expect(profileDeps[0].type).toBe('profile_use');
  });

  it('should detect multiple USE BEHAVIOR_PROFILE: references', () => {
    const deps = extractDependencies(AGENT_WITH_MULTIPLE_PROFILES);
    const profileDeps = deps.filter((d) => d.type === 'profile_use');

    expect(profileDeps).toHaveLength(2);
    const targets = profileDeps.map((d) => d.targetAgent);
    expect(targets).toContain('formal_tone');
    expect(targets).toContain('concise_style');
  });

  it('should detect hyphenated USE BEHAVIOR_PROFILE references', () => {
    const deps = extractDependencies(AGENT_WITH_HYPHENATED_PROFILE);
    const profileDeps = deps.filter((d) => d.type === 'profile_use');

    expect(profileDeps).toHaveLength(1);
    expect(profileDeps[0].targetAgent).toBe('voice-optimized');
  });

  it('should deduplicate same-profile references', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test"

USE BEHAVIOR_PROFILE: formal_tone
USE BEHAVIOR_PROFILE: formal_tone

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

    const deps = extractDependencies(dsl);
    const profileDeps = deps.filter((d) => d.type === 'profile_use');

    expect(profileDeps).toHaveLength(1);
    expect(profileDeps[0].targetAgent).toBe('formal_tone');
  });

  it('should include correct sourceLine for profile references', () => {
    const deps = extractDependencies(AGENT_WITH_PROFILE);
    const profileDep = deps.find((d) => d.type === 'profile_use');

    expect(profileDep).toBeDefined();
    expect(profileDep!.sourceLine).toBeGreaterThan(0);
  });

  it('should not detect profile references in comments', () => {
    const dsl = `AGENT: TestAgent
GOAL: "Test"

# USE BEHAVIOR_PROFILE: formal_tone

COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

    const deps = extractDependencies(dsl);
    const profileDeps = deps.filter((d) => d.type === 'profile_use');

    expect(profileDeps).toHaveLength(0);
  });

  it('should not interfere with other dependency types', () => {
    const dsl = `SUPERVISOR: Main
GOAL: "Route"

USE BEHAVIOR_PROFILE: formal_tone

HANDOFF:
  - TO: Worker
    WHEN: true

DELEGATE:
  - AGENT: Helper
    PURPOSE: "help"`;

    const deps = extractDependencies(dsl);
    const profileDeps = deps.filter((d) => d.type === 'profile_use');
    const handoffs = deps.filter((d) => d.type === 'handoff');
    const delegates = deps.filter((d) => d.type === 'delegate');

    expect(profileDeps).toHaveLength(1);
    expect(profileDeps[0].targetAgent).toBe('formal_tone');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].targetAgent).toBe('Worker');
    expect(delegates).toHaveLength(1);
    expect(delegates[0].targetAgent).toBe('Helper');
  });

  it('should return empty array for agent with no dependencies or profiles', () => {
    const simpleDsl = `AGENT: Simple
GOAL: "Do nothing"
COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

    const deps = extractDependencies(simpleDsl);
    expect(deps).toHaveLength(0);
  });
});

// ─── importProject: profile diffs ────────────────────────────────────────────

describe('importProject profile diffs', () => {
  it('should detect added profile files', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL);
    files.set('behavior_profiles/concise_style.behavior_profile.abl', PROFILE_CONCISE);

    const emptyState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
    };

    const result = importProject(files, emptyState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.added).toContain(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.added).toContain(
      'behavior_profiles/concise_style.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });

  it('should import v2 manifest-declared .profile.abl files through the legacy importer', () => {
    const files = new Map<string, string>();
    files.set(
      'project.json',
      JSON.stringify({
        format_version: '2.0',
        layers_included: ['core'],
        behavior_profiles: {
          formal_tone: {
            path: 'behavior_profiles/formal_tone.profile.abl',
          },
        },
      }),
    );
    files.set('agents/styled.agent.abl', AGENT_WITH_PROFILE);
    files.set('behavior_profiles/formal_tone.profile.abl', PROFILE_FORMAL);

    const emptyState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
    };

    const result = importProject(files, emptyState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.dependencyValidation.valid).toBe(true);
    expect(result.preview.changes.profiles.added).toContain(
      'behavior_profiles/formal_tone.profile.abl',
    );
  });

  it('should detect modified profile files', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_MODIFIED);

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL],
      ]),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.modified).toContain(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });

  it('should detect removed profile files', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL],
        ['behavior_profiles/concise_style.behavior_profile.abl', PROFILE_CONCISE],
      ]),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.removed).toContain(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.removed).toContain(
      'behavior_profiles/concise_style.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
  });

  it('should handle mixed profile changes (add, modify, remove)', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_MODIFIED);
    files.set(
      'behavior_profiles/new_profile.behavior_profile.abl',
      'BEHAVIOR_PROFILE: new_profile\nPRIORITY: 1\nWHEN: true',
    );

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL],
        ['behavior_profiles/concise_style.behavior_profile.abl', PROFILE_CONCISE],
      ]),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.added).toContain(
      'behavior_profiles/new_profile.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.modified).toContain(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.removed).toContain(
      'behavior_profiles/concise_style.behavior_profile.abl',
    );
  });

  it('should handle empty/missing profiles gracefully', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);

    const emptyState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
    };

    const result = importProject(files, emptyState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });

  it('should not report unchanged profiles', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);
    files.set('behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL);

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/formal_tone.behavior_profile.abl', PROFILE_FORMAL],
      ]),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });

  it('should include profiles section in emptyPreview on folder validation failure', () => {
    const files = new Map<string, string>();
    // No agent files — will fail validation
    files.set('config/models.json', '{}');

    const result = importProject(
      files,
      { agents: new Map(), toolFiles: new Map() },
      makeImportOptions(),
    );

    expect(result.success).toBe(false);
    expect(result.preview.changes.profiles).toBeDefined();
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });
});
