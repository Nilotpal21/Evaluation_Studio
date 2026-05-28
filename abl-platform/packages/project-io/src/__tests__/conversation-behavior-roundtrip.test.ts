import { describe, expect, it } from 'vitest';
import { buildFileMap, type AgentFileEntry } from '../export/folder-builder.js';
import { readFolder } from '../import/folder-reader.js';
import { validateImport } from '../import/import-validator.js';
import { importProject, type ExistingProjectState } from '../import/project-importer.js';
import type { ImportOptions } from '../types.js';

const AGENT_DSL = `AGENT: Concierge
VERSION: "1.0"

GOAL: "Help premium callers"

USE BEHAVIOR_PROFILE: voice_vip

CONVERSATION:
  speaking:
    style: "warm and concise"
    max_sentences: 2
  interaction:
    clarification:
      mode: ask_only_when_blocked
      max_questions: 1
`;

const AGENT_DSL_MODIFIED = `AGENT: Concierge
VERSION: "1.0"

GOAL: "Help premium callers"

USE BEHAVIOR_PROFILE: voice_vip

CONVERSATION:
  speaking:
    style: "warm and concise"
    max_sentences: 1
  interaction:
    clarification:
      mode: ask_only_when_blocked
      max_questions: 1
`;

const PROFILE_DSL = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 5
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    tool_lead_in: brief
  interaction:
    closure: summarize_outcome
`;

const PROFILE_DSL_MODIFIED = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 5
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    tool_lead_in: explained
  interaction:
    closure: summarize_outcome
`;

function makeImportOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    projectId: 'proj-conversation',
    userId: 'user-1',
    tenantId: 'tenant-1',
    files: new Map(),
    ...overrides,
  };
}

describe('conversation behavior project-io roundtrip', () => {
  it('preserves agent and profile CONVERSATION blocks through export/read-folder roundtrip', () => {
    const agents: AgentFileEntry[] = [
      { name: 'Concierge', dslContent: AGENT_DSL, isSupervisor: false },
    ];
    const profiles = new Map([['voice_vip', PROFILE_DSL]]);

    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);
    const readResult = readFolder(fileMap);

    expect(readResult.success).toBe(true);
    expect(readResult.agentFiles.get('agents/concierge.agent.yaml')).toContain('CONVERSATION:');
    expect(readResult.agentFiles.get('agents/concierge.agent.yaml')).toContain('max_sentences: 2');
    expect(
      readResult.profileFiles.get('behavior_profiles/voice_vip.behavior_profile.abl'),
    ).toContain('CONVERSATION:');
    expect(
      readResult.profileFiles.get('behavior_profiles/voice_vip.behavior_profile.abl'),
    ).toContain('tool_lead_in: brief');

    const validation = validateImport(readResult.agentFiles, new Map(), readResult.profileFiles);
    expect(validation.valid).toBe(true);
    expect(validation.syntaxErrors).toEqual([]);
  });

  it('detects modified agent and profile conversation behavior in import preview', () => {
    const agents: AgentFileEntry[] = [
      { name: 'Concierge', dslContent: AGENT_DSL_MODIFIED, isSupervisor: false },
    ];
    const profiles = new Map([['voice_vip', PROFILE_DSL_MODIFIED]]);
    const fileMap = buildFileMap(agents, [], new Map(), new Map(), undefined, 'yaml', profiles);

    const existingState: ExistingProjectState = {
      agents: new Map([
        [
          'Concierge',
          {
            name: 'Concierge',
            dslContent: AGENT_DSL,
          },
        ],
      ]),
      toolFiles: new Map(),
      profileFiles: new Map([['behavior_profiles/voice_vip.behavior_profile.abl', PROFILE_DSL]]),
    };

    const result = importProject(fileMap, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.agents.modified).toEqual([
      expect.objectContaining({ name: 'Concierge' }),
    ]);
    expect(result.preview.changes.profiles.modified).toContain(
      'behavior_profiles/voice_vip.behavior_profile.abl',
    );
  });
});
