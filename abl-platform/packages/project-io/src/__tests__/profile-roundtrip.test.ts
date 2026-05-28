/**
 * Profile Round-Trip Tests (Export -> Import)
 *
 * Tests the full export -> import cycle for behavior profiles:
 * - Build file map with agents and profiles using buildFileMap
 * - Read back using readFolder
 * - Verify profile files are correctly categorized
 * - Import into a project using importProject
 * - Verify profiles appear in the import preview
 *
 * Test cases:
 * 1. Export with profiles -> readFolder -> profileFiles preserved
 * 2. Profile content round-trips correctly (content matches)
 * 3. Import detects new profiles as "added"
 * 4. Import detects modified profiles
 * 5. Import detects removed profiles
 * 6. Export -> import with no profiles -> no profile changes
 */

import { describe, it, expect } from 'vitest';
import { buildFileMap, profileFilePath, type AgentFileEntry } from '../export/folder-builder.js';
import { readFolder } from '../import/folder-reader.js';
import { importProject, type ExistingProjectState } from '../import/project-importer.js';
import type { ImportOptions } from '../types.js';

// =============================================================================
// TEST FIXTURES
// =============================================================================

const AGENT_DSL = `AGENT: booking_agent
VERSION: "1.0"
GOAL: "Help users book hotels"
COMPLETE:
  - WHEN: true
    RESPOND: "Booking complete"`;

const SUPERVISOR_DSL = `SUPERVISOR: main_supervisor
VERSION: "1.0"
GOAL: "Route user requests"

HANDOFF:
  - TO: booking_agent
    WHEN: true`;

const WHATSAPP_PROFILE = `BEHAVIOR_PROFILE: whatsapp_mode
PRIORITY: 10
WHEN: channel.name == "whatsapp"
INSTRUCTIONS: "Use short messages. No markdown formatting."
CONSTRAINTS:
  - "response_length < 500"
TOOLS:
  HIDE:
    - send_sms`;

const VOICE_PROFILE = `BEHAVIOR_PROFILE: voice_mode
PRIORITY: 20
WHEN: channel.name == "voice"
INSTRUCTIONS: "Speak naturally. Avoid technical jargon."`;

const WHATSAPP_PROFILE_MODIFIED = `BEHAVIOR_PROFILE: whatsapp_mode
PRIORITY: 15
WHEN: channel.name == "whatsapp" || channel.name == "sms"
INSTRUCTIONS: "Use very short messages. No markdown. No emojis."
CONSTRAINTS:
  - "response_length < 300"
TOOLS:
  HIDE:
    - send_sms
    - send_email`;

const PROFILE_IMPORT_PREVIEW_TIMEOUT_MS = 15_000;

function makeImportOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    projectId: 'proj-roundtrip',
    userId: 'user-1',
    tenantId: 'tenant-1',
    files: new Map(),
    ...overrides,
  };
}

function makeEmptyState(): ExistingProjectState {
  return {
    agents: new Map(),
    toolFiles: new Map(),
  };
}

// =============================================================================
// EXPORT -> READ FOLDER -> PROFILES PRESERVED
// =============================================================================

describe('profile round-trip: export -> readFolder', () => {
  it('should export with profiles and readFolder preserves profileFiles', () => {
    // Build file map with agents and profiles
    const agents: AgentFileEntry[] = [
      { name: 'main_supervisor', dslContent: SUPERVISOR_DSL, isSupervisor: true },
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];
    const profiles = new Map([
      ['whatsapp_mode', WHATSAPP_PROFILE],
      ['voice_mode', VOICE_PROFILE],
    ]);

    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

    // Verify file map contains profile files
    expect(fileMap.has('behavior_profiles/whatsapp_mode.behavior_profile.abl')).toBe(true);
    expect(fileMap.has('behavior_profiles/voice_mode.behavior_profile.abl')).toBe(true);

    // Read the exported file map back
    const readResult = readFolder(fileMap);

    expect(readResult.success).toBe(true);
    expect(readResult.profileFiles.size).toBe(2);
    expect(
      readResult.profileFiles.has('behavior_profiles/whatsapp_mode.behavior_profile.abl'),
    ).toBe(true);
    expect(readResult.profileFiles.has('behavior_profiles/voice_mode.behavior_profile.abl')).toBe(
      true,
    );

    // Agent files should also be present
    expect(readResult.agentFiles.size).toBe(2);
  });

  it('should preserve profile content exactly through round-trip', () => {
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];
    const profiles = new Map([['whatsapp_mode', WHATSAPP_PROFILE]]);

    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);
    const readResult = readFolder(fileMap);

    // Content should match exactly
    const roundTrippedContent = readResult.profileFiles.get(
      'behavior_profiles/whatsapp_mode.behavior_profile.abl',
    );
    expect(roundTrippedContent).toBe(WHATSAPP_PROFILE);
  });

  it('should handle export with no profiles and readFolder returns empty profileFiles', () => {
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];

    const fileMap = buildFileMap(agents, [], new Map(), new Map());
    const readResult = readFolder(fileMap);

    expect(readResult.success).toBe(true);
    expect(readResult.profileFiles.size).toBe(0);
  });

  it('should correctly separate profiles from agents and other file types', () => {
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];
    const configs = new Map([['models.json', '{}']]);
    const deployments = new Map([['dev.deployment.json', '{}']]);
    const locales = new Map([['en/booking_agent.json', '{"greeting": "Hello"}']]);
    const profiles = new Map([['whatsapp_mode', WHATSAPP_PROFILE]]);

    const fileMap = buildFileMap(agents, [], configs, deployments, locales, 'yaml', profiles);
    const readResult = readFolder(fileMap);

    expect(readResult.success).toBe(true);
    expect(readResult.agentFiles.size).toBe(1);
    expect(readResult.configFiles.size).toBe(1);
    expect(readResult.deploymentFiles.size).toBe(1);
    expect(readResult.localeFiles.size).toBe(1);
    expect(readResult.profileFiles.size).toBe(1);

    // Each type is in the correct bucket
    expect(readResult.agentFiles.has('agents/booking_agent.agent.yaml')).toBe(true);
    expect(readResult.configFiles.has('config/models.json')).toBe(true);
    expect(readResult.deploymentFiles.has('deployments/dev.deployment.json')).toBe(true);
    expect(readResult.localeFiles.has('locales/en/booking_agent.json')).toBe(true);
    expect(
      readResult.profileFiles.has('behavior_profiles/whatsapp_mode.behavior_profile.abl'),
    ).toBe(true);
  });
});

// =============================================================================
// IMPORT: DETECT NEW PROFILES (ADDED)
// =============================================================================

describe('profile round-trip: import detects new profiles', () => {
  it(
    'should detect new profiles as added in import preview',
    { timeout: PROFILE_IMPORT_PREVIEW_TIMEOUT_MS },
    () => {
      // Export with profiles
      const agents: AgentFileEntry[] = [
        { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
      ];
      const profiles = new Map([
        ['whatsapp_mode', WHATSAPP_PROFILE],
        ['voice_mode', VOICE_PROFILE],
      ]);

      const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

      // Import into empty project
      const result = importProject(fileMap, makeEmptyState(), makeImportOptions());

      expect(result.success).toBe(true);
      expect(result.preview.changes.profiles.added).toContain(
        'behavior_profiles/whatsapp_mode.behavior_profile.abl',
      );
      expect(result.preview.changes.profiles.added).toContain(
        'behavior_profiles/voice_mode.behavior_profile.abl',
      );
      expect(result.preview.changes.profiles.modified).toHaveLength(0);
      expect(result.preview.changes.profiles.removed).toHaveLength(0);
    },
  );
});

// =============================================================================
// IMPORT: DETECT MODIFIED PROFILES
// =============================================================================

describe('profile round-trip: import detects modified profiles', () => {
  it('should detect modified profiles in import preview', () => {
    // Export with modified profile
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];
    const profiles = new Map([['whatsapp_mode', WHATSAPP_PROFILE_MODIFIED]]);

    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

    // Import into project that already has the original profile
    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/whatsapp_mode.behavior_profile.abl', WHATSAPP_PROFILE],
      ]),
    };

    const result = importProject(fileMap, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.modified).toContain(
      'behavior_profiles/whatsapp_mode.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });
});

// =============================================================================
// IMPORT: DETECT REMOVED PROFILES
// =============================================================================

describe('profile round-trip: import detects removed profiles', () => {
  it('should detect removed profiles when importing without them', () => {
    // Export with NO profiles
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];

    const fileMap = buildFileMap(agents, [], new Map(), new Map());

    // Import into project that already has profiles
    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/whatsapp_mode.behavior_profile.abl', WHATSAPP_PROFILE],
        ['behavior_profiles/voice_mode.behavior_profile.abl', VOICE_PROFILE],
      ]),
    };

    const result = importProject(fileMap, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.removed).toContain(
      'behavior_profiles/whatsapp_mode.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.removed).toContain(
      'behavior_profiles/voice_mode.behavior_profile.abl',
    );
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
  });
});

// =============================================================================
// IMPORT: NO PROFILES -> NO PROFILE CHANGES
// =============================================================================

describe('profile round-trip: no profiles -> no changes', () => {
  it('should report no profile changes when neither import nor existing has profiles', () => {
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];

    const fileMap = buildFileMap(agents, [], new Map(), new Map());

    const result = importProject(fileMap, makeEmptyState(), makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });

  it('should report no profile changes when imported profiles match existing profiles exactly', () => {
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];
    const profiles = new Map([['whatsapp_mode', WHATSAPP_PROFILE]]);

    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

    // Existing state has the exact same profile content
    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/whatsapp_mode.behavior_profile.abl', WHATSAPP_PROFILE],
      ]),
    };

    const result = importProject(fileMap, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.profiles.added).toHaveLength(0);
    expect(result.preview.changes.profiles.modified).toHaveLength(0);
    expect(result.preview.changes.profiles.removed).toHaveLength(0);
  });
});

// =============================================================================
// MIXED SCENARIO: ADD + MODIFY + REMOVE IN ONE IMPORT
// =============================================================================

describe('profile round-trip: mixed add/modify/remove', () => {
  it('should handle mixed profile changes in a single import', () => {
    const agents: AgentFileEntry[] = [
      { name: 'booking_agent', dslContent: AGENT_DSL, isSupervisor: false },
    ];

    // Import: modified whatsapp_mode, new sms_mode, no voice_mode (removed)
    const smsProfile = `BEHAVIOR_PROFILE: sms_mode
PRIORITY: 5
WHEN: channel.name == "sms"
INSTRUCTIONS: "Keep it under 160 chars."`;

    const profiles = new Map([
      ['whatsapp_mode', WHATSAPP_PROFILE_MODIFIED],
      ['sms_mode', smsProfile],
    ]);

    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      profileFiles: new Map([
        ['behavior_profiles/whatsapp_mode.behavior_profile.abl', WHATSAPP_PROFILE],
        ['behavior_profiles/voice_mode.behavior_profile.abl', VOICE_PROFILE],
      ]),
    };

    const result = importProject(fileMap, existingState, makeImportOptions());

    expect(result.success).toBe(true);

    // sms_mode is new
    expect(result.preview.changes.profiles.added).toContain(
      'behavior_profiles/sms_mode.behavior_profile.abl',
    );

    // whatsapp_mode is modified
    expect(result.preview.changes.profiles.modified).toContain(
      'behavior_profiles/whatsapp_mode.behavior_profile.abl',
    );

    // voice_mode is removed
    expect(result.preview.changes.profiles.removed).toContain(
      'behavior_profiles/voice_mode.behavior_profile.abl',
    );
  });
});

// =============================================================================
// FILE PATH GENERATION
// =============================================================================

describe('profile round-trip: file path generation', () => {
  it('should generate correct file paths via profileFilePath', () => {
    expect(profileFilePath('whatsapp_mode')).toBe(
      'behavior_profiles/whatsapp_mode.behavior_profile.abl',
    );
    expect(profileFilePath('voice_mode')).toBe('behavior_profiles/voice_mode.behavior_profile.abl');
    expect(profileFilePath('Formal Tone')).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
  });

  it('should normalize profile names with hyphens and special chars', () => {
    expect(profileFilePath('my-profile')).toBe('behavior_profiles/my_profile.behavior_profile.abl');
    expect(profileFilePath('Profile With Spaces!')).toBe(
      'behavior_profiles/profile_with_spaces_.behavior_profile.abl',
    );
  });
});
