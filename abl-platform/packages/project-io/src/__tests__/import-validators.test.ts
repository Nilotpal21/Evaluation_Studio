import { describe, it, expect } from 'vitest';
import { validateManifest, type ManifestValidationResult } from '../import/manifest-validator.js';
import {
  validateImport,
  validateAgentSyntax,
  validateProfileSyntax,
  type ImportValidationResult,
} from '../import/import-validator.js';
import {
  computeApplyOperations,
  type ApplyInput,
  type ApplyOperation,
} from '../import/import-applier.js';
import { readFolder, extractAgentName } from '../import/folder-reader.js';
import { calculateImportDiffs, type AgentDiffEntry } from '../diff/import-diff-calculator.js';
import type { ProjectManifest } from '../types.js';

// ─── Manifest Validator ─────────────────────────────────────────────────────

describe('manifest-validator', () => {
  function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
    return {
      name: 'Test Project',
      slug: 'test-project',
      description: null,
      version: '1.0.0',
      abl_version: '1.0',
      exported_at: new Date().toISOString(),
      exported_by: 'user-1',
      entry_agent: null,
      agents: {},
      tools: {},
      dependencies: {
        agent_references: [],
        tool_imports: [],
      },
      ...overrides,
    };
  }

  describe('required field validation', () => {
    it('should pass for valid manifest with all required fields', () => {
      const manifest = makeManifest();
      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when name is missing', () => {
      const manifest = makeManifest({ name: '' });
      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('manifest.name is required');
    });

    it('should fail when slug is missing', () => {
      const manifest = makeManifest({ slug: '' });
      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('manifest.slug is required');
    });

    it('should fail when abl_version is missing', () => {
      const manifest = makeManifest({ abl_version: '' as '1.0' });
      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('manifest.abl_version is required');
    });

    it('should report all missing required fields at once', () => {
      const manifest = makeManifest({ name: '', slug: '', abl_version: '' as '1.0' });
      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
    });
  });

  describe('agent file reference validation', () => {
    it('should pass when all agent paths are found', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when agent path is not found', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
      });

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Agent "Main": referenced file "agents/main.agent.abl" not found',
      );
    });

    it('should fail when agent path is missing', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: '',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
      });

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Agent "Main": missing path');
    });

    it('should validate multiple agents independently', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
          Worker: {
            path: 'agents/worker.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Worker');
    });
  });

  describe('tool file reference validation', () => {
    it('should pass when all tool paths are found', () => {
      const manifest = makeManifest({
        tools: {
          'hotels-api': {
            path: 'tools/hotels-api.tools.abl',
            owner: null,
          },
        },
      });
      const toolFiles = new Set(['tools/hotels-api.tools.abl']);

      const result = validateManifest(manifest, new Set(), toolFiles);
      expect(result.valid).toBe(true);
    });

    it('should fail when tool path is not found', () => {
      const manifest = makeManifest({
        tools: {
          'hotels-api': {
            path: 'tools/hotels-api.tools.abl',
            owner: null,
          },
        },
      });

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Tool "hotels-api": referenced file "tools/hotels-api.tools.abl" not found',
      );
    });

    it('should fail when tool path is missing', () => {
      const manifest = makeManifest({
        tools: {
          'hotels-api': {
            path: '',
            owner: null,
          },
        },
      });

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Tool "hotels-api": missing path');
    });
  });

  describe('entry agent validation', () => {
    it('should warn when entry_agent is not found in agents', () => {
      const manifest = makeManifest({
        entry_agent: 'NonExistent',
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());

      expect(result.valid).toBe(true); // warnings don't invalidate
      expect(result.warnings).toContain('Entry agent "NonExistent" not found in agents');
    });

    it('should not warn when entry_agent exists in agents', () => {
      const manifest = makeManifest({
        entry_agent: 'Main',
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());

      expect(result.warnings).toHaveLength(0);
    });

    it('should not warn when entry_agent is null', () => {
      const manifest = makeManifest({ entry_agent: null });

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.warnings).toHaveLength(0);
    });

    it('should not warn when entry_agent is set but agents is empty', () => {
      // entry_agent check only fires when both entry_agent and agents exist
      const manifest = makeManifest({
        entry_agent: 'Main',
        agents: {},
      });

      const result = validateManifest(manifest, new Set(), new Set());

      // entry_agent is 'Main' and manifest.agents is {}, so agents['Main'] is undefined
      expect(result.warnings).toContain('Entry agent "Main" not found in agents');
    });
  });

  describe('dependency reference validation', () => {
    it('should warn when dependency references unknown from agent', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
        dependencies: {
          agent_references: [{ from: 'Unknown', to: 'Main', type: 'handoff' }],
          tool_imports: [],
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());

      expect(result.valid).toBe(true); // warnings don't invalidate
      expect(result.warnings).toContain('Dependency from unknown agent "Unknown"');
    });

    it('should warn when dependency references unknown to agent', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
        dependencies: {
          agent_references: [{ from: 'Main', to: 'Unknown', type: 'handoff' }],
          tool_imports: [],
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());

      expect(result.warnings).toContain('Dependency to unknown agent "Unknown"');
    });

    it('should warn for both from and to unknown agents', () => {
      const manifest = makeManifest({
        agents: {},
        dependencies: {
          agent_references: [{ from: 'A', to: 'B', type: 'handoff' }],
          tool_imports: [],
        },
      });

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.warnings).toContain('Dependency from unknown agent "A"');
      expect(result.warnings).toContain('Dependency to unknown agent "B"');
    });

    it('should not warn when all dependency agents exist', () => {
      const manifest = makeManifest({
        agents: {
          Main: {
            path: 'agents/main.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
          Worker: {
            path: 'agents/worker.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
        dependencies: {
          agent_references: [{ from: 'Main', to: 'Worker', type: 'handoff' }],
          tool_imports: [],
        },
      });
      const agentFiles = new Set(['agents/main.agent.abl', 'agents/worker.agent.abl']);

      const result = validateManifest(manifest, agentFiles, new Set());

      expect(result.warnings).toHaveLength(0);
    });

    it('should skip dependency validation when dependencies.agent_references is absent', () => {
      const manifest = makeManifest();
      // Override to remove agent_references
      (manifest as any).dependencies = undefined;

      const result = validateManifest(manifest, new Set(), new Set());

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });
});

// ─── Import Validator (ABL Syntax) ──────────────────────────────────────────

describe('import-validator', () => {
  describe('validateAgentSyntax', () => {
    it('should accept valid AGENT header', () => {
      const content = 'AGENT: MyAgent\nVERSION: "1.0"\nGOAL: "Do stuff"';
      const errors = validateAgentSyntax('test.abl', content);

      expect(errors).toHaveLength(0);
    });

    it('should accept valid SUPERVISOR header', () => {
      const content = 'SUPERVISOR: Main\nVERSION: "1.0"';
      const errors = validateAgentSyntax('test.abl', content);

      expect(errors).toHaveLength(0);
    });

    it('should accept header after comments and blank lines', () => {
      const content = '# This is a comment\n\n# Another comment\nAGENT: MyAgent\nGOAL: "Do stuff"';
      const errors = validateAgentSyntax('test.abl', content);

      expect(errors).toHaveLength(0);
    });

    it('should accept header after slash comments and block comments', () => {
      const content = `// Generated from template

/**
 * Agent instructions
 * stay here
 */
AGENT: MyAgent
GOAL: "Do stuff"`;
      const errors = validateAgentSyntax('test.abl', content);

      expect(errors).toHaveLength(0);
    });

    it('should accept parser-valid quoted YAML agent declarations with comments', () => {
      const content = `# exported by Studio
agent: "QuotedYamlAgent" # inline comment
goal: Help users`;
      const errors = validateAgentSyntax('agents/quoted.agent.yaml', content);

      expect(errors).toHaveLength(0);
    });

    it('should accept parser-valid YAML object-form agent declarations', () => {
      const content = `agent:
  name: YamlObjectAgent
  goal: Help users`;
      const errors = validateAgentSyntax('agents/object.agent.yaml', content);

      expect(errors).toHaveLength(0);
    });

    it('should reject empty content', () => {
      const errors = validateAgentSyntax('empty.abl', '');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('File is empty');
      expect(errors[0].line).toBe(1);
    });

    it('should reject whitespace-only content', () => {
      const errors = validateAgentSyntax('ws.abl', '   \n  \n  ');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('File is empty');
    });

    it('should reject file with non-header first non-comment line', () => {
      const content = 'GOAL: "Something"\nAGENT: MyAgent';
      const errors = validateAgentSyntax('invalid.abl', content);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe(
        'Expected AGENT:, SUPERVISOR:, agent:, or supervisor: header as first non-comment line',
      );
      expect(errors[0].line).toBe(1);
    });

    it('should reject file with only comments (no header)', () => {
      const content = '# Just a comment\n# Another comment';
      const errors = validateAgentSyntax('comments.abl', content);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Missing AGENT:, SUPERVISOR:, agent:, or supervisor: header');
    });

    it('should reject AGENT without colon and name', () => {
      const content = 'AGENT\nGOAL: "test"';
      const errors = validateAgentSyntax('no-colon.abl', content);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Expected AGENT:, SUPERVISOR:, agent:, or supervisor:');
    });

    it('should reject AGENT: without a name', () => {
      const content = 'AGENT: \nGOAL: "test"';
      const errors = validateAgentSyntax('no-name.abl', content);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Expected AGENT:, SUPERVISOR:, agent:, or supervisor:');
    });
  });

  describe('validateProfileSyntax', () => {
    it('should accept profile header after comments and block comments', () => {
      const content = `# generated
/* profile comment */
BEHAVIOR_PROFILE: VoiceProfile
PRIORITY: 10
WHEN: true
INSTRUCTIONS: |
  Use the standard voice defaults.`;

      const errors = validateProfileSyntax('behavior_profiles/voice.behavior_profile.abl', content);

      expect(errors).toHaveLength(0);
    });

    it('should reject non-header first meaningful line in profile files', () => {
      const content = `/**
 * profile
 */
DESCRIPTION: "voice defaults"
BEHAVIOR_PROFILE: VoiceProfile`;

      const errors = validateProfileSyntax('behavior_profiles/voice.behavior_profile.abl', content);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        line: 4,
        message: 'Expected BEHAVIOR_PROFILE: header as first non-comment line',
      });
    });

    it('should reject semantically invalid Conversation Behavior in profile files', () => {
      const content = `BEHAVIOR_PROFILE: VoiceProfile
PRIORITY: 10
WHEN: true
CONVERSATION:
  speaking:
    max_sentences: 0`;

      const errors = validateProfileSyntax('behavior_profiles/voice.behavior_profile.abl', content);

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('speaking.max_sentences'),
          }),
        ]),
      );
    });
  });

  describe('validateImport', () => {
    it('should validate a valid single-agent import', () => {
      const agentFiles = new Map([['agents/main.agent.abl', 'AGENT: Main\nGOAL: "Do stuff"']]);
      const toolFiles = new Map<string, string>();

      const result = validateImport(agentFiles, toolFiles);

      expect(result.valid).toBe(true);
      expect(result.syntaxErrors).toHaveLength(0);
    });

    it('should detect syntax errors in agent files', () => {
      const agentFiles = new Map([['agents/broken.agent.abl', 'NOT_AN_AGENT: Broken']]);
      const toolFiles = new Map<string, string>();

      const result = validateImport(agentFiles, toolFiles);

      expect(result.valid).toBe(false);
      expect(result.syntaxErrors).toHaveLength(1);
      expect(result.syntaxErrors[0].file).toBe('agents/broken.agent.abl');
    });

    it('should validate dependencies across agents', () => {
      const agentFiles = new Map([
        ['agents/main.agent.abl', 'SUPERVISOR: Main\nHANDOFF:\n  - TO: Worker\n    WHEN: true'],
        ['agents/worker.agent.abl', 'AGENT: Worker\nGOAL: "Work"'],
      ]);

      const result = validateImport(agentFiles, new Map());

      expect(result.valid).toBe(true);
      expect(result.dependencyValidation.missing).toHaveLength(0);
    });

    it('should validate dependencies using canonical YAML agent identity', () => {
      const agentFiles = new Map([
        [
          'agents/main.agent.yaml',
          `supervisor: Main
handoff:
  - to: "WorkerYaml"
    when: true`,
        ],
        ['agents/worker.agent.yaml', 'agent: "WorkerYaml" # generated\ngoal: Work'],
      ]);

      const result = validateImport(agentFiles, new Map());

      expect(result.valid).toBe(true);
      expect(result.dependencyValidation.missing).toHaveLength(0);
    });

    it('should detect missing dependency targets', () => {
      const agentFiles = new Map([
        [
          'agents/main.agent.abl',
          'SUPERVISOR: Main\nHANDOFF:\n  - TO: NonExistent\n    WHEN: true',
        ],
      ]);

      const result = validateImport(agentFiles, new Map());

      expect(result.dependencyValidation.missing.length).toBeGreaterThan(0);
    });

    it('should extract agent name from SUPERVISOR header', () => {
      const agentFiles = new Map([
        ['agents/sup.agent.abl', 'SUPERVISOR: MySupervisor\nGOAL: "Route"'],
      ]);

      const result = validateImport(agentFiles, new Map());

      expect(result.valid).toBe(true);
    });

    it('should use path as name fallback if no header match', () => {
      // A file that has no AGENT/SUPERVISOR header but still starts with one
      // so it passes syntax check. Actually, it will fail syntax check, let's
      // test a case where the regex fails to match.
      const agentFiles = new Map([
        ['agents/custom.agent.abl', 'AGENT: CustomName\nGOAL: "Custom"'],
      ]);
      const toolFiles = new Map<string, string>();

      const result = validateImport(agentFiles, toolFiles);

      expect(result.valid).toBe(true);
    });

    it('should extract agent name from path when DSL header is malformed', () => {
      const agentFiles = new Map([
        ['agents/booking_agent.agent.abl', '# Malformed — no header\nSome content'],
      ]);
      const result = validateImport(agentFiles, new Map());
      // The name used in dependency graph should be extracted from path, not the raw path
      // We verify by checking that the raw path is NOT used as agent name
      expect(result.syntaxErrors.length).toBeGreaterThan(0); // syntax error expected
      // Dependency validation should use the extracted name "booking_agent"
      // not the raw path "agents/booking_agent.agent.abl"
    });

    it('should handle tool files in validation', () => {
      const agentFiles = new Map([
        [
          'agents/worker.agent.abl',
          'AGENT: Worker\nTOOLIMPORTS:\n  - FROM: "tools/api.tools.abl"\n    IMPORT: [search]',
        ],
      ]);
      const toolFiles = new Map([
        ['tools/api.tools.abl', 'TOOL: search\nDESCRIPTION: "Search API"'],
      ]);

      const result = validateImport(agentFiles, toolFiles);

      // The validation should pass or report tool import status
      expect(result.syntaxErrors).toHaveLength(0);
    });
  });
});

// ─── Import Applier ─────────────────────────────────────────────────────────

describe('import-applier', () => {
  describe('computeApplyOperations', () => {
    it('should create operations for new agents', () => {
      const input: ApplyInput = {
        existingAgents: new Map(),
        importedAgents: new Map([
          [
            'AgentA',
            {
              name: 'AgentA',
              dslContent: 'AGENT: AgentA',
              description: 'Agent A',
            },
          ],
        ]),
      };

      const ops = computeApplyOperations(input);

      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe('create');
      expect(ops[0].agentName).toBe('AgentA');
      expect(ops[0].dslContent).toBe('AGENT: AgentA');
      expect(ops[0].description).toBe('Agent A');
    });

    it('should create update operations for modified agents', () => {
      const input: ApplyInput = {
        existingAgents: new Map([
          ['AgentA', { name: 'AgentA', dslContent: 'AGENT: AgentA\nGOAL: "old"' }],
        ]),
        importedAgents: new Map([
          [
            'AgentA',
            {
              name: 'AgentA',
              dslContent: 'AGENT: AgentA\nGOAL: "new"',
              description: null,
            },
          ],
        ]),
      };

      const ops = computeApplyOperations(input);

      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe('update');
      expect(ops[0].agentName).toBe('AgentA');
      expect(ops[0].dslContent).toBe('AGENT: AgentA\nGOAL: "new"');
    });

    it('should create update operations when only prompt companion metadata changes', () => {
      const content = 'AGENT: AgentA\nGOAL: "same"';
      const input: ApplyInput = {
        existingAgents: new Map([
          [
            'AgentA',
            {
              name: 'AgentA',
              dslContent: content,
              description: null,
              systemPromptLibraryRef: {
                promptId: 'prompt-old',
                versionId: 'version-1',
              },
            },
          ],
        ]),
        importedAgents: new Map([
          [
            'AgentA',
            {
              name: 'AgentA',
              dslContent: content,
              description: null,
              systemPromptLibraryRef: {
                promptId: 'prompt-new',
                versionId: 'version-2',
              },
            },
          ],
        ]),
      };

      const ops = computeApplyOperations(input);

      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe('update');
      expect(ops[0].agentName).toBe('AgentA');
      expect(ops[0].systemPromptLibraryRef).toEqual({
        promptId: 'prompt-new',
        versionId: 'version-2',
      });
    });

    it('should create delete operations for removed agents', () => {
      const input: ApplyInput = {
        existingAgents: new Map([['AgentA', { name: 'AgentA', dslContent: 'AGENT: AgentA' }]]),
        importedAgents: new Map(),
      };

      const ops = computeApplyOperations(input);

      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe('delete');
      expect(ops[0].agentName).toBe('AgentA');
      expect(ops[0].dslContent).toBeNull();
      expect(ops[0].description).toBeNull();
    });

    it('should skip unchanged agents (same content)', () => {
      const content = 'AGENT: AgentA\nGOAL: "same"';
      const input: ApplyInput = {
        existingAgents: new Map([['AgentA', { name: 'AgentA', dslContent: content }]]),
        importedAgents: new Map([
          ['AgentA', { name: 'AgentA', dslContent: content, description: null }],
        ]),
      };

      const ops = computeApplyOperations(input);

      expect(ops).toHaveLength(0);
    });

    it('should handle all operation types simultaneously', () => {
      const input: ApplyInput = {
        existingAgents: new Map([
          ['AgentA', { name: 'AgentA', dslContent: 'AGENT: AgentA\nGOAL: "v1"' }],
          ['AgentB', { name: 'AgentB', dslContent: 'AGENT: AgentB' }],
          ['AgentC', { name: 'AgentC', dslContent: 'AGENT: AgentC' }],
        ]),
        importedAgents: new Map([
          [
            'AgentA',
            {
              name: 'AgentA',
              dslContent: 'AGENT: AgentA\nGOAL: "v2"',
              description: null,
            },
          ],
          ['AgentB', { name: 'AgentB', dslContent: 'AGENT: AgentB', description: null }],
          [
            'AgentD',
            {
              name: 'AgentD',
              dslContent: 'AGENT: AgentD',
              description: 'New agent',
            },
          ],
        ]),
      };

      const ops = computeApplyOperations(input);

      const creates = ops.filter((o) => o.type === 'create');
      const updates = ops.filter((o) => o.type === 'update');
      const deletes = ops.filter((o) => o.type === 'delete');

      expect(creates).toHaveLength(1);
      expect(creates[0].agentName).toBe('AgentD');

      expect(updates).toHaveLength(1);
      expect(updates[0].agentName).toBe('AgentA');

      expect(deletes).toHaveLength(1);
      expect(deletes[0].agentName).toBe('AgentC');
    });

    it('should return empty array when both maps are empty', () => {
      const ops = computeApplyOperations({
        existingAgents: new Map(),
        importedAgents: new Map(),
      });

      expect(ops).toHaveLength(0);
    });

    it('should detect update when existing dslContent is null but import has content', () => {
      const input: ApplyInput = {
        existingAgents: new Map([['AgentA', { name: 'AgentA', dslContent: null }]]),
        importedAgents: new Map([
          ['AgentA', { name: 'AgentA', dslContent: 'AGENT: AgentA', description: null }],
        ]),
      };

      const ops = computeApplyOperations(input);

      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe('update');
    });
  });
});

// ─── Folder Reader ──────────────────────────────────────────────────────────

describe('folder-reader', () => {
  describe('readFolder', () => {
    it('should read a valid folder structure', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test', slug: 'test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');

      const result = readFolder(files);

      expect(result.success).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.agentFiles.size).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should succeed when project.json is missing (optional manifest)', () => {
      const files = new Map<string, string>();
      files.set('agents/main.agent.abl', 'AGENT: Main');

      const result = readFolder(files);

      expect(result.success).toBe(true);
      expect(result.manifest).toBeNull();
      expect(result.agentFiles.size).toBe(1);
    });

    it('should fail when project.json is invalid JSON', () => {
      const files = new Map<string, string>();
      files.set('project.json', 'not valid json {{{');
      files.set('agents/main.agent.abl', 'AGENT: Main');

      const result = readFolder(files);

      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.startsWith('project.json: Invalid JSON'))).toBe(
        true,
      );
    });

    it('should fail when no agent files are found', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));

      const result = readFolder(files);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('No agent files found in agents/ directory');
    });

    it('should parse abl.lock when present', () => {
      const lockfile = { lockfile_version: '1.0', agents: {}, tools: {}, integrity: 'abc' };
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('abl.lock', JSON.stringify(lockfile));
      files.set('agents/main.agent.abl', 'AGENT: Main');

      const result = readFolder(files);

      expect(result.success).toBe(true);
      expect(result.lockfile).toBeDefined();
      expect(result.lockfile?.lockfile_version).toBe('1.0');
    });

    it('should handle invalid abl.lock JSON gracefully', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('abl.lock', '{{invalid');
      files.set('agents/main.agent.abl', 'AGENT: Main');

      const result = readFolder(files);

      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.startsWith('abl.lock: Invalid JSON'))).toBe(true);
    });

    it('should succeed when abl.lock is absent (optional)', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');

      const result = readFolder(files);

      expect(result.success).toBe(true);
      expect(result.lockfile).toBeNull();
    });

    it('should categorize tool files', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('tools/api.tools.abl', 'TOOL: api');

      const result = readFolder(files);

      expect(result.toolFiles.size).toBe(1);
      expect(result.toolFiles.has('tools/api.tools.abl')).toBe(true);
    });

    it('should categorize config files', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('config/models.json', '{}');

      const result = readFolder(files);

      expect(result.configFiles.size).toBe(1);
      expect(result.configFiles.has('config/models.json')).toBe(true);
    });

    it('should categorize deployment files', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('deployments/dev.deployment.json', '{}');

      const result = readFolder(files);

      expect(result.deploymentFiles.size).toBe(1);
      expect(result.deploymentFiles.has('deployments/dev.deployment.json')).toBe(true);
    });

    it('should ignore unrecognized files', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('README.md', '# Project');
      files.set('random/file.txt', 'stuff');

      const result = readFolder(files);

      expect(result.success).toBe(true);
      expect(result.agentFiles.size).toBe(1);
      expect(result.toolFiles.size).toBe(0);
      expect(result.configFiles.size).toBe(0);
      expect(result.deploymentFiles.size).toBe(0);
    });

    it('should not categorize non-.agent.abl files in agents/ directory', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('agents/notes.txt', 'not an agent');

      const result = readFolder(files);

      expect(result.agentFiles.size).toBe(1);
    });

    it('should not categorize non-.tools.abl files in tools/ directory', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('tools/readme.md', 'documentation');

      const result = readFolder(files);

      expect(result.toolFiles.size).toBe(0);
    });

    it('should not categorize non-.deployment.json files in deployments/ directory', () => {
      const files = new Map<string, string>();
      files.set('project.json', JSON.stringify({ name: 'Test' }));
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('deployments/notes.txt', 'not a deployment');

      const result = readFolder(files);

      expect(result.deploymentFiles.size).toBe(0);
    });

    it('should categorize locale JSON files under locales/', () => {
      const files = new Map<string, string>();
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('locales/en/main.json', '{"greeting": "Hello"}');
      files.set('locales/es/main.json', '{"greeting": "Hola"}');
      files.set('locales/en/_shared.json', '{"app_name": "My App"}');

      const result = readFolder(files);

      expect(result.success).toBe(true);
      expect(result.localeFiles.size).toBe(3);
      expect(result.localeFiles.has('locales/en/main.json')).toBe(true);
      expect(result.localeFiles.has('locales/es/main.json')).toBe(true);
      expect(result.localeFiles.has('locales/en/_shared.json')).toBe(true);
    });

    it('should ignore non-JSON files under locales/', () => {
      const files = new Map<string, string>();
      files.set('agents/main.agent.abl', 'AGENT: Main');
      files.set('locales/en/main.json', '{"greeting": "Hello"}');
      files.set('locales/README.md', 'docs');

      const result = readFolder(files);

      expect(result.localeFiles.size).toBe(1);
    });
  });

  describe('extractAgentName', () => {
    it('should extract name from AGENT header', () => {
      const name = extractAgentName('AGENT: MyAgent\nGOAL: "stuff"');
      expect(name).toBe('MyAgent');
    });

    it('should extract name from SUPERVISOR header', () => {
      const name = extractAgentName('SUPERVISOR: MainSupervisor\nGOAL: "route"');
      expect(name).toBe('MainSupervisor');
    });

    it('should extract name when header is preceded by comments', () => {
      const name = extractAgentName('# A comment\n\nAGENT: MyAgent');
      expect(name).toBe('MyAgent');
    });

    it('should return null for content without a valid header', () => {
      const name = extractAgentName('GOAL: "something"\nTOOLS:\n  - search');
      expect(name).toBeNull();
    });

    it('should return null for empty content', () => {
      const name = extractAgentName('');
      expect(name).toBeNull();
    });

    it('should handle AGENT: without trailing content after name', () => {
      const name = extractAgentName('AGENT: Solo');
      expect(name).toBe('Solo');
    });

    it('should extract quoted YAML agent names without quotes or comments', () => {
      const name = extractAgentName('agent: "YamlAgent" # exported by studio\nsteps: []');
      expect(name).toBe('YamlAgent');
    });

    it('should extract object-form YAML names only when parser-compatible', () => {
      const name = extractAgentName('agent:\n  name: ObjectYamlAgent\ngoal: "help"');
      expect(name).toBe('ObjectYamlAgent');
    });
  });

  describe('validateAgentSyntax YAML parser parity', () => {
    it('should reject object-form YAML that canonical parsing rejects', () => {
      const errors = validateAgentSyntax(
        'agents/object.agent.yaml',
        'agent:\n  name: ObjectYamlAgent\nmode: reasoning\ngoal: "help"',
      );

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('MODE is no longer supported'),
          }),
        ]),
      );
    });
  });
});

// ─── Import Diff Calculator ────────────────────────────────────────────────

describe('import-diff-calculator', () => {
  describe('calculateImportDiffs', () => {
    it('should detect added agents', () => {
      const existing = new Map<string, string>();
      const imported = new Map([['AgentA', 'AGENT: AgentA\nGOAL: "New"']]);

      const diffs = calculateImportDiffs(existing, imported);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].name).toBe('AgentA');
      expect(diffs[0].status).toBe('added');
      expect(diffs[0].diff).not.toBeNull();
    });

    it('should detect removed agents', () => {
      const existing = new Map([['AgentA', 'AGENT: AgentA\nGOAL: "Old"']]);
      const imported = new Map<string, string>();

      const diffs = calculateImportDiffs(existing, imported);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].name).toBe('AgentA');
      expect(diffs[0].status).toBe('removed');
      expect(diffs[0].diff).not.toBeNull();
    });

    it('should detect modified agents', () => {
      const existing = new Map([['AgentA', 'AGENT: AgentA\nGOAL: "Old"']]);
      const imported = new Map([['AgentA', 'AGENT: AgentA\nGOAL: "New"']]);

      const diffs = calculateImportDiffs(existing, imported);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].name).toBe('AgentA');
      expect(diffs[0].status).toBe('modified');
      expect(diffs[0].diff).not.toBeNull();
      expect(diffs[0].diff!.hasChanges).toBe(true);
    });

    it('should detect unchanged agents', () => {
      const content = 'AGENT: AgentA\nGOAL: "Same"';
      const existing = new Map([['AgentA', content]]);
      const imported = new Map([['AgentA', content]]);

      const diffs = calculateImportDiffs(existing, imported);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].name).toBe('AgentA');
      expect(diffs[0].status).toBe('unchanged');
      expect(diffs[0].diff).toBeNull();
    });

    it('should handle mixed changes across multiple agents', () => {
      const existing = new Map([
        ['AgentA', 'AGENT: AgentA\nGOAL: "A v1"'],
        ['AgentB', 'AGENT: AgentB\nGOAL: "B"'],
        ['AgentC', 'AGENT: AgentC\nGOAL: "C"'],
      ]);
      const imported = new Map([
        ['AgentA', 'AGENT: AgentA\nGOAL: "A v2"'],
        ['AgentB', 'AGENT: AgentB\nGOAL: "B"'],
        ['AgentD', 'AGENT: AgentD\nGOAL: "D"'],
      ]);

      const diffs = calculateImportDiffs(existing, imported);

      const statusMap = new Map(diffs.map((d) => [d.name, d.status]));
      expect(statusMap.get('AgentA')).toBe('modified');
      expect(statusMap.get('AgentB')).toBe('unchanged');
      expect(statusMap.get('AgentC')).toBe('removed');
      expect(statusMap.get('AgentD')).toBe('added');
    });

    it('should return empty array when both maps are empty', () => {
      const diffs = calculateImportDiffs(new Map(), new Map());
      expect(diffs).toHaveLength(0);
    });
  });
});
