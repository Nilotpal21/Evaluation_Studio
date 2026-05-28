import { describe, expect, it } from 'vitest';
import {
  buildCompilerModel,
  buildPackageDiagnostics,
  diagnoseTranscriptFailure,
  lintAblFiles,
} from '../lib/abl-package-analysis';

const SUPPORT_AGENT = `AGENT: SupportAgent
VERSION: "1.0"

GOAL: "Help shoppers resolve support issues"

USE BEHAVIOR_PROFILE: concise_voice

FLOW:
  greet -> finalize

  greet:
    REASONING: false
    RESPOND: "Hello"
    THEN: finalize

  finalize:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`;

const CONCISE_PROFILE = `BEHAVIOR_PROFILE: concise_voice

PRIORITY: 10
WHEN: channel.name == "voice"

INSTRUCTIONS: |
  Keep responses concise and direct.
`;

function packageFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'project.json': JSON.stringify({
      format_version: '2.0',
      name: 'Support',
      slug: 'support',
      entry_agent: 'SupportAgent',
      layers_included: ['core'],
      behavior_profiles: {
        concise_voice: {
          name: 'concise_voice',
          path: 'behavior_profiles/concise_voice.behavior_profile.abl',
          priority: 10,
          when_summary: 'channel.name == "voice"',
          used_by: ['SupportAgent'],
        },
      },
    }),
    'agents/support.agent.abl': SUPPORT_AGENT,
    'behavior_profiles/concise_voice.behavior_profile.abl': CONCISE_PROFILE,
    ...overrides,
  };
}

describe('ABL package analysis', () => {
  it('exposes the compiler-visible model for profiles, agents, handoffs, and unresolved refs', () => {
    const model = buildCompilerModel(packageFiles());

    expect(model.manifest.entryAgent).toBe('SupportAgent');
    expect(model.manifest.layersIncluded).toEqual(['core']);
    expect(model.manifest.behaviorProfiles.concise_voice).toEqual({
      path: 'behavior_profiles/concise_voice.behavior_profile.abl',
      priority: 10,
      usedBy: ['SupportAgent'],
    });
    expect(model.behaviorProfiles).toEqual([
      {
        name: 'concise_voice',
        file: 'behavior_profiles/concise_voice.behavior_profile.abl',
        priority: 10,
        when: 'channel.name == "voice"',
        usedBy: ['SupportAgent'],
      },
    ]);
    expect(model.agents[0]).toMatchObject({
      name: 'SupportAgent',
      usesBehaviorProfiles: ['concise_voice'],
      flow: {
        entryPoint: 'greet',
      },
      compiledBehaviorProfiles: ['concise_voice'],
    });
    expect(model.unresolvedRefs).toEqual([]);
  });

  it('normalizes wrapped package files before folder and compiler analysis', () => {
    const wrappedFiles = Object.fromEntries(
      Object.entries(packageFiles()).map(([file, content]) => [
        `voltmart-support/${file}`,
        content,
      ]),
    );

    const diagnostics = buildPackageDiagnostics(wrappedFiles);
    const model = buildCompilerModel(wrappedFiles);

    expect(diagnostics.valid).toBe(true);
    expect(diagnostics.summary.agentFiles).toBe(1);
    expect(diagnostics.summary.behaviorProfileFiles).toBe(1);
    expect(model.agents[0]?.file).toBe('agents/support.agent.abl');
    expect(model.behaviorProfiles[0]?.file).toBe(
      'behavior_profiles/concise_voice.behavior_profile.abl',
    );
  });

  it('includes manifest-declared .profile.abl behavior profiles in the compiler model', () => {
    const files = packageFiles({
      'project.json': JSON.stringify({
        format_version: '2.0',
        name: 'Support',
        slug: 'support',
        entry_agent: 'SupportAgent',
        layers_included: ['core'],
        behavior_profiles: {
          concise_voice: {
            name: 'concise_voice',
            path: 'behavior_profiles/concise_voice.profile.abl',
            priority: 10,
            when_summary: 'channel.name == "voice"',
            used_by: ['SupportAgent'],
          },
        },
      }),
      'behavior_profiles/concise_voice.profile.abl': CONCISE_PROFILE,
    });
    delete files['behavior_profiles/concise_voice.behavior_profile.abl'];

    const diagnostics = buildPackageDiagnostics(files);
    const model = buildCompilerModel(files);

    expect(diagnostics.valid).toBe(true);
    expect(diagnostics.summary.behaviorProfileFiles).toBe(1);
    expect(model.behaviorProfiles).toEqual([
      expect.objectContaining({
        name: 'concise_voice',
        file: 'behavior_profiles/concise_voice.profile.abl',
      }),
    ]);
    expect(model.unresolvedRefs).toEqual([]);
  });

  it('normalizes invalid platform-layer contract issues with actionable fixes', () => {
    const diagnostics = buildPackageDiagnostics(
      packageFiles({
        'project.json': JSON.stringify({
          format_version: '2.0',
          name: 'Support',
          slug: 'support',
          layers_included: ['core', 'behavior_profiles'],
          metadata: {
            entity_counts: {
              core: 1,
            },
          },
        }),
      }),
    );

    expect(diagnostics.valid).toBe(false);
    expect(diagnostics.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'folder',
          severity: 'error',
          message: 'project.json: Unknown layer "behavior_profiles" in layers_included',
          suggestedFix: expect.stringContaining('Behavior profiles are part of core'),
        }),
      ]),
    );
  });

  it('explains that manifest-declared behavior profiles still require package files', () => {
    const files = packageFiles();
    delete files['behavior_profiles/concise_voice.behavior_profile.abl'];
    const diagnostics = buildPackageDiagnostics(files);

    expect(diagnostics.valid).toBe(false);
    expect(diagnostics.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'E_BEHAVIOR_PROFILE_MISSING_PATH',
          file: 'behavior_profiles/concise_voice.behavior_profile.abl',
          suggestedFix: expect.stringContaining('Add the referenced behavior_profiles'),
        }),
      ]),
    );
  });

  it('flags repair risks that make ABL transcripts hard to debug', () => {
    const issues = lintAblFiles({
      'agents/support.agent.abl': `AGENT: SupportAgent
GOAL: "Help shoppers"

FLOW:
  plan -> finalize

  plan:
    REASONING: true
    CALL: create_ticket
    RESPOND: "Ticket created"
    THEN: finalize

  finalize:

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ABL_EMPTY_RESPOND', line: 17 }),
        expect.objectContaining({ code: 'ABL_EMPTY_FINALIZE_STEP', line: 13 }),
        expect.objectContaining({ code: 'ABL_REASONING_TOOL_AND_TEXT_RISK', line: 7 }),
      ]),
    );
  });

  it('diagnoses finalize to COMPLETE to empty RESPOND transcript failures with file lines', () => {
    const files = packageFiles({
      'agents/support.agent.abl': `AGENT: SupportAgent
GOAL: "Help shoppers"

FLOW:
  start -> finalize

  start:
    REASONING: false
    RESPOND: "Working on it"
    THEN: finalize

  finalize:
    REASONING: false
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    const diagnosis = diagnoseTranscriptFailure(
      {
        events: [{ step: 'finalize' }],
      },
      files,
    );

    expect(diagnosis.findings).toEqual([
      expect.objectContaining({
        agent: 'SupportAgent',
        file: 'agents/support.agent.abl',
        step: 'finalize',
        thenLine: 14,
        completionLine: 18,
        suggestedFix: expect.stringContaining('non-empty closeout'),
      }),
    ]);
  });
});
