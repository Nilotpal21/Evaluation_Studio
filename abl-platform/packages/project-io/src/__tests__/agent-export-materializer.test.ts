import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCompileABLtoIR,
  mockParseAgentBasedABL,
  mockIsYamlFormat,
  mockSerializeToYAML,
  mockResolvePromptLibraryRefOnDocument,
  mockParseBehaviorProfileDocumentsFromConfigVariables,
} = vi.hoisted(() => ({
  mockCompileABLtoIR: vi.fn(),
  mockParseAgentBasedABL: vi.fn(),
  mockIsYamlFormat: vi.fn(),
  mockSerializeToYAML: vi.fn(),
  mockResolvePromptLibraryRefOnDocument: vi.fn(),
  mockParseBehaviorProfileDocumentsFromConfigVariables: vi.fn(),
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: mockCompileABLtoIR,
}));

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: mockParseAgentBasedABL,
  isYamlFormat: mockIsYamlFormat,
}));

vi.mock('@abl/language-service', () => ({
  serializeToYAML: mockSerializeToYAML,
}));

vi.mock('@agent-platform/shared/prompts', () => ({
  resolvePromptLibraryRefOnDocument: (...args: unknown[]) =>
    mockResolvePromptLibraryRefOnDocument(...args),
}));

vi.mock('../behavior-profile-documents.js', () => ({
  parseBehaviorProfileDocumentsFromConfigVariables: (...args: unknown[]) =>
    mockParseBehaviorProfileDocumentsFromConfigVariables(...args),
}));

import {
  materializeAgentExport,
  materializeProjectAgentExports,
} from '../export/agent-export-materializer.js';

describe('materializeAgentExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsYamlFormat.mockReturnValue(false);
    mockParseAgentBasedABL.mockReturnValue({ document: null, errors: [{ message: 'invalid' }] });
    mockCompileABLtoIR.mockReturnValue({ agents: {} });
    mockSerializeToYAML.mockReturnValue('supervisor: Main\n');
    mockResolvePromptLibraryRefOnDocument.mockResolvedValue(undefined);
    mockParseBehaviorProfileDocumentsFromConfigVariables.mockReturnValue({
      documents: [],
      errors: [],
    });
  });

  it('emits strict YAML when parse and compile succeed', () => {
    const parsedDocument = { name: 'Main' };
    mockParseAgentBasedABL.mockReturnValue({ document: parsedDocument, errors: [] });
    mockCompileABLtoIR.mockReturnValue({
      agents: {
        Main: { name: 'Main', goal: 'Route requests' },
      },
    });
    mockSerializeToYAML.mockReturnValue('supervisor: Main\ngoal: Route requests\n');

    const result = materializeAgentExport('Main', 'SUPERVISOR: Main\nGOAL: Route requests');

    expect(result).toEqual({
      content: 'supervisor: Main\ngoal: Route requests\n',
      format: 'yaml',
      warnings: [],
    });
    expect(mockCompileABLtoIR).toHaveBeenCalledWith([parsedDocument], { mode: 'preview' });
  });

  it('keeps existing YAML when the source is YAML but canonical materialization is unavailable', () => {
    const yamlSource = 'supervisor: Main\ngoal: Route requests\n';
    mockIsYamlFormat.mockReturnValue(true);
    mockParseAgentBasedABL.mockReturnValue({ document: null, errors: [{ message: 'invalid' }] });

    const result = materializeAgentExport('Main', yamlSource);

    expect(result.format).toBe('yaml');
    expect(result.content).toBe(yamlSource);
    expect(result.warnings).toEqual([
      expect.stringContaining('Kept existing YAML source for agent "Main"'),
    ]);
  });

  it('falls back to legacy ABL when strict YAML export is unavailable', () => {
    const ablSource = 'SUPERVISOR: Broken\nGOAL: Route requests';

    const result = materializeAgentExport('Broken', ablSource);

    expect(result.format).toBe('abl');
    expect(result.content).toBe(ablSource);
    expect(result.warnings).toEqual([
      expect.stringContaining('Exported agent "Broken" as .agent.abl'),
    ]);
  });

  it('records materialization failures before preserving YAML source', () => {
    const yamlSource = 'supervisor: Main\ngoal: Route requests\n';
    mockIsYamlFormat.mockReturnValue(true);
    mockParseAgentBasedABL.mockImplementation(() => {
      throw new Error('compiler unavailable');
    });

    const result = materializeAgentExport('Main', yamlSource);

    expect(result.format).toBe('yaml');
    expect(result.warnings).toEqual([
      expect.stringContaining('YAML materialization failed for agent "Main": compiler unavailable'),
      expect.stringContaining('Kept existing YAML source for agent "Main"'),
    ]);
  });

  it('materializes project-aware YAML with sibling agents, config variables, and prompt refs', async () => {
    const routerDoc = { name: 'RouterAgent' };
    const specialistDoc = { name: 'SpecialistAgent' };
    const profileDoc = { name: 'voice_vip', meta: { kind: 'behavior_profile' } };

    mockParseAgentBasedABL.mockImplementation((dsl: string) => {
      if (dsl.includes('RouterAgent')) {
        return { document: routerDoc, errors: [] };
      }
      if (dsl.includes('SpecialistAgent')) {
        return { document: specialistDoc, errors: [] };
      }
      return { document: null, errors: [{ message: 'invalid' }] };
    });
    mockParseBehaviorProfileDocumentsFromConfigVariables.mockReturnValue({
      documents: [profileDoc],
      errors: [],
    });
    mockResolvePromptLibraryRefOnDocument.mockImplementation(async (document: any) => {
      document.systemPrompt = 'Resolved system prompt';
      document.systemPromptLibraryRef = {
        ...(document.systemPromptLibraryRef ?? {}),
        resolvedHash: 'prompt-hash-1',
      };
    });
    mockCompileABLtoIR.mockReturnValue({
      agents: {
        RouterAgent: { name: 'RouterAgent', goal: 'Route requests' },
        SpecialistAgent: { name: 'SpecialistAgent', goal: 'Do specialist work' },
      },
    });
    mockSerializeToYAML.mockImplementation((ir: Record<string, unknown>) => `agent: ${ir.name}\n`);

    const result = await materializeProjectAgentExports({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'RouterAgent',
          dslContent: 'AGENT: RouterAgent\nGOAL: "Route requests"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
        {
          name: 'SpecialistAgent',
          dslContent: 'AGENT: SpecialistAgent\nGOAL: "Do specialist work"\n',
        },
      ],
      configVariables: {
        'profile:voice_vip': 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 10\nWHEN: true',
      },
    });

    expect(mockResolvePromptLibraryRefOnDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RouterAgent',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      }),
      { tenantId: 'tenant-1', projectId: 'proj-1' },
    );
    expect(mockCompileABLtoIR).toHaveBeenCalledWith([routerDoc, specialistDoc, profileDoc], {
      mode: 'preview',
      config_variables: {
        'profile:voice_vip': 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 10\nWHEN: true',
      },
    });
    expect(result.get('RouterAgent')).toEqual({
      content: 'agent: RouterAgent\n',
      format: 'yaml',
      warnings: [],
    });
    expect(result.get('SpecialistAgent')).toEqual({
      content: 'agent: SpecialistAgent\n',
      format: 'yaml',
      warnings: [],
    });
  });
});
