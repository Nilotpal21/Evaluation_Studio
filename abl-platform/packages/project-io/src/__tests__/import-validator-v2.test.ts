/**
 * Tests for Import Validator v2 — SHA verification and cross-layer deps
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  verifySHAIntegrity,
  validateCrossLayerDeps,
  validateImport,
} from '../import/import-validator.js';
import { readFolderV2 } from '../import/folder-reader.js';
import { computeProjectAgentDraftArtifactSourceHash } from '../project-agent-draft-metadata.js';
import type { LockFileV2 } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** Build a lockfile with arbitrary section entries keyed by file paths */
function makeLockfileWithSections(
  sectionEntries: Partial<
    Record<string, Record<string, { source_hash: string; [k: string]: unknown }>>
  >,
  options: { legacyIntegrityWithoutBehaviorProfiles?: boolean } = {},
): LockFileV2 {
  const sortRecord = (obj: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

  const lockfile: LockFileV2 = {
    lockfile_version: '2.0',
    generated_at: '2026-03-07T10:00:00Z',
    agents: (sectionEntries.agents as LockFileV2['agents']) ?? {},
    tools: (sectionEntries.tools as LockFileV2['tools']) ?? {},
    configs: (sectionEntries.configs as LockFileV2['configs']) ?? {},
    connections: (sectionEntries.connections as LockFileV2['connections']) ?? {},
    guardrails: (sectionEntries.guardrails as LockFileV2['guardrails']) ?? {},
    workflows: (sectionEntries.workflows as LockFileV2['workflows']) ?? {},
    evals: (sectionEntries.evals as LockFileV2['evals']) ?? {},
    search: (sectionEntries.search as LockFileV2['search']) ?? {},
    channels: (sectionEntries.channels as LockFileV2['channels']) ?? {},
    vocabulary: (sectionEntries.vocabulary as LockFileV2['vocabulary']) ?? {},
    ...(sectionEntries.behavior_profiles
      ? {
          behavior_profiles: sectionEntries.behavior_profiles as NonNullable<
            LockFileV2['behavior_profiles']
          >,
        }
      : {}),
    layer_hashes: {},
    integrity: '',
  };

  const integrityPayloadData: Record<string, unknown> = {
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
    layer_hashes: sortRecord(lockfile.layer_hashes),
  };
  if (lockfile.behavior_profiles !== undefined && !options.legacyIntegrityWithoutBehaviorProfiles) {
    integrityPayloadData.behavior_profiles = sortRecord(lockfile.behavior_profiles);
  }
  const integrityPayload = JSON.stringify(integrityPayloadData);
  lockfile.integrity = createHash('sha256').update(integrityPayload, 'utf8').digest('hex');

  return lockfile;
}

function makeTestLockfile(files: Map<string, string>): LockFileV2 {
  const agentContent = files.get('agents/supervisor.agent.abl') ?? '';
  const toolContent = files.get('tools/hotels_api.tools.abl') ?? '';

  return makeLockfileWithSections({
    agents: {
      supervisor: {
        version: '1.0',
        source_hash: computeHash(agentContent),
        status: 'active',
      },
    },
    tools: {
      hotels_api: { source_hash: computeHash(toolContent) },
    },
  });
}

// ─── SHA Verification Tests ─────────────────────────────────────────────

describe('verifySHAIntegrity', () => {
  const files = new Map<string, string>();
  files.set('agents/supervisor.agent.abl', 'AGENT: Supervisor\nGOAL: Route');
  files.set('tools/hotels_api.tools.abl', 'TOOL: HotelsAPI');

  it('should pass verification when files match lockfile', () => {
    const lockfile = makeTestLockfile(files);
    const result = verifySHAIntegrity(lockfile, files);

    expect(result.valid).toBe(true);
    expect(result.integrityMatch).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should detect integrity hash mismatch', () => {
    const lockfile = makeTestLockfile(files);
    lockfile.integrity = 'tampered_hash';

    const result = verifySHAIntegrity(lockfile, files);

    expect(result.integrityMatch).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('integrity hash mismatch');
  });

  it('should detect per-file hash mismatch', () => {
    const lockfile = makeTestLockfile(files);

    // Modify a file after lockfile was generated
    const modifiedFiles = new Map(files);
    modifiedFiles.set('agents/supervisor.agent.abl', 'AGENT: Supervisor\nGOAL: Modified goal');

    const result = verifySHAIntegrity(lockfile, modifiedFiles);

    expect(result.layerResults.agents.valid).toBe(false);
    expect(result.layerResults.agents.mismatchedFiles).toContain('supervisor');
  });

  it('should accept companion-aware agent hashes when project manifest carries prompt refs', () => {
    const companionFiles = new Map<string, string>();
    const agentContent = 'AGENT: Supervisor\nGOAL: Route';
    companionFiles.set('agents/supervisor.agent.abl', agentContent);
    companionFiles.set(
      'project.json',
      JSON.stringify({
        name: 'Test Project',
        slug: 'test-project',
        description: null,
        version: '1.0.0',
        abl_version: '1.0',
        exported_at: '2026-05-02T00:00:00.000Z',
        exported_by: 'user-1',
        entry_agent: 'Supervisor',
        dsl_format: 'legacy',
        agents: {
          Supervisor: {
            path: 'agents/supervisor.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          },
        },
        tools: {},
        dependencies: {
          agent_references: [],
          tool_imports: [],
        },
      }),
    );

    const lockfile = makeLockfileWithSections({
      agents: {
        Supervisor: {
          version: '1.0',
          source_hash:
            computeProjectAgentDraftArtifactSourceHash({
              recordName: 'Supervisor',
              dslContent: agentContent,
              systemPromptLibraryRef: {
                promptId: 'prompt-1',
                versionId: 'version-1',
                resolvedHash: 'prompt-hash-1',
              },
            }) ?? computeHash(agentContent),
          status: 'active',
        },
      },
    });

    const result = verifySHAIntegrity(lockfile, companionFiles);

    expect(result.valid).toBe(true);
    expect(result.layerResults.agents.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should report warning for missing files', () => {
    const lockfile = makeTestLockfile(files);

    // Remove agent file
    const partialFiles = new Map<string, string>();
    partialFiles.set('tools/hotels_api.tools.abl', 'TOOL: HotelsAPI');

    const result = verifySHAIntegrity(lockfile, partialFiles);

    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('should handle empty lockfile sections', () => {
    const lockfile = makeTestLockfile(files);

    const result = verifySHAIntegrity(lockfile, files);

    // Empty sections like configs, connections should still validate
    expect(result.layerResults.configs.valid).toBe(true);
    expect(result.layerResults.connections.valid).toBe(true);
  });

  it('should verify behavior profiles from legacy lockfiles whose root integrity excluded the profile section', () => {
    const profileContent = 'BEHAVIOR_PROFILE: voltmart_voice\nSTYLE: concise';
    const importFiles = new Map<string, string>();
    importFiles.set('agents/supervisor.agent.abl', 'AGENT: Supervisor\nPROFILE: voltmart_voice');
    importFiles.set('behavior_profiles/voltmart_voice.profile.abl', profileContent);

    const lockfile = makeLockfileWithSections(
      {
        agents: {
          Supervisor: {
            version: '1.0',
            source_hash: computeHash(importFiles.get('agents/supervisor.agent.abl') ?? ''),
            status: 'active',
          },
        },
        behavior_profiles: {
          'behavior_profiles/voltmart_voice.profile.abl': {
            source_hash: computeHash(profileContent),
          },
        },
      },
      { legacyIntegrityWithoutBehaviorProfiles: true },
    );

    const result = verifySHAIntegrity(lockfile, importFiles);

    expect(result.valid).toBe(true);
    expect(result.integrityMatch).toBe(true);
    expect(result.layerResults.behavior_profiles.valid).toBe(true);
  });

  it('should resolve legacy name-keyed behavior profile lockfile entries', () => {
    const profileContent = 'BEHAVIOR_PROFILE: voice\nSTYLE: concise';
    const importFiles = new Map<string, string>();
    importFiles.set('behavior_profiles/voice.profile.abl', profileContent);

    const lockfile = makeLockfileWithSections({
      behavior_profiles: {
        voice: {
          source_hash: computeHash(profileContent),
        },
      },
    });

    const result = verifySHAIntegrity(lockfile, importFiles);

    expect(result.valid).toBe(true);
    expect(result.layerResults.behavior_profiles.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

// ─── Cross-Layer Dependency Tests ───────────────────────────────────────

describe('validateCrossLayerDeps', () => {
  it('should pass when all tool references exist', () => {
    const files = new Map<string, string>();
    files.set(
      'agents/main.agent.abl',
      'AGENT: Main\nGOAL: Route\nTOOLS:\n  - hotelsapi\n  - flightsapi',
    );
    files.set('tools/hotelsapi.tools.abl', 'TOOL: HotelsAPI');
    files.set('tools/flightsapi.tools.abl', 'TOOL: FlightsAPI');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(true);
    expect(result.missingDependencies.length).toBe(0);
  });

  it('should detect missing tool references', () => {
    const files = new Map<string, string>();
    files.set(
      'agents/main.agent.abl',
      'AGENT: Main\nGOAL: Route\nTOOLS:\n  - hotelsapi\n  - MissingTool',
    );
    files.set('tools/hotelsapi.tools.abl', 'TOOL: HotelsAPI');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(false);
    expect(result.missingDependencies.length).toBe(1);
    expect(result.missingDependencies[0].target).toBe('MissingTool');
    expect(result.missingDependencies[0].type).toBe('tool_import');
  });

  it('should warn about missing connector references', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Do stuff');
    files.set('tools/crm.tools.abl', 'TOOL: CRM\nCONNECTOR: salesforce');
    files.set('connections/connectors/zendesk.connection.json', '{"name": "zendesk"}');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.warnings.some((w) => w.includes('salesforce'))).toBe(true);
  });

  it('should not warn about connectors when connections layer is empty', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Do stuff');
    files.set('tools/crm.tools.abl', 'TOOL: CRM\nCONNECTOR: salesforce');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    // No warning since connections layer wasn't included
    expect(result.warnings.some((w) => w.includes('salesforce'))).toBe(false);
  });

  it('should handle agents with no tool references', () => {
    const files = new Map<string, string>();
    files.set('agents/simple.agent.abl', 'AGENT: Simple\nGOAL: Just chat');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(true);
  });

  it('should extract tool references from USE: directives', () => {
    const files = new Map<string, string>();
    files.set(
      'agents/main.agent.abl',
      'AGENT: Main\nGOAL: Route\nUSE: SearchTool\nUSE: AnalyticsTool',
    );
    files.set('tools/searchtool.tools.abl', 'TOOL: SearchTool');
    // AnalyticsTool is missing

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(false);
    expect(result.missingDependencies.length).toBe(1);
    expect(result.missingDependencies[0].target).toBe('AnalyticsTool');
    expect(result.missingDependencies[0].type).toBe('tool_import');
  });

  it('should resolve connectors from connectorName key in connection JSON', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Do stuff');
    files.set('tools/crm.tools.abl', 'TOOL: CRM\nCONNECTOR: sf_connector');
    files.set(
      'connections/connectors/sf.connection.json',
      JSON.stringify({ connectorName: 'sf_connector' }),
    );

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    // sf_connector is available via connectorName, so no warning
    expect(result.warnings.some((w) => w.includes('sf_connector'))).toBe(false);
  });

  it('should skip unparseable connection JSON without error', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Do stuff');
    files.set('tools/crm.tools.abl', 'TOOL: CRM\nCONNECTOR: salesforce');
    files.set('connections/connectors/bad.connection.json', '{not valid json!!!');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    // Should still warn about salesforce, but not throw
    expect(result.warnings.some((w) => w.includes('salesforce'))).toBe(true);
  });

  it('should fall back to path when agent content has no header', () => {
    const files = new Map<string, string>();
    // No AGENT: header — just plain text content
    files.set('agents/noheader.agent.abl', 'GOAL: Just chat\nTOOLS:\n  - MissingTool');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(false);
    expect(result.missingDependencies.length).toBe(1);
    // Source should fall back to the path since no AGENT: header
    expect(result.missingDependencies[0].source).toBe('agents/noheader.agent.abl');
  });
});

// ─── findFileForEntry Pattern Coverage ──────────────────────────────────

describe('verifySHAIntegrity — findFileForEntry patterns', () => {
  it('should match configs section → config/{name}.json', () => {
    const configContent = '{"key": "value"}';
    const files = new Map<string, string>();
    files.set('config/app_settings.json', configContent);

    const lockfile = makeLockfileWithSections({
      configs: { app_settings: { source_hash: computeHash(configContent) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.configs.valid).toBe(true);
    expect(result.layerResults.configs.mismatchedFiles).toHaveLength(0);
  });

  it('should match connections section → connectors path', () => {
    const connContent = '{"name": "salesforce"}';
    const files = new Map<string, string>();
    files.set('connections/connectors/salesforce.connection.json', connContent);

    const lockfile = makeLockfileWithSections({
      connections: { salesforce: { source_hash: computeHash(connContent) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.connections.valid).toBe(true);
  });

  it('should match configs section → core/mcp-servers path', () => {
    const mcpContent = '{"server": "local"}';
    const files = new Map<string, string>();
    files.set('core/mcp-servers/local.mcp-config.json', mcpContent);

    const lockfile = makeLockfileWithSections({
      configs: { local: { source_hash: computeHash(mcpContent) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.configs.valid).toBe(true);
  });

  it('should match guardrails section → guardrails/{name}.guardrail.json', () => {
    const content = '{"type": "input_filter"}';
    const files = new Map<string, string>();
    files.set('guardrails/pii_filter.guardrail.json', content);

    const lockfile = makeLockfileWithSections({
      guardrails: { pii_filter: { source_hash: computeHash(content) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.guardrails.valid).toBe(true);
  });

  it('should match guardrails section → guardrails/{name}.guardrail.yaml', () => {
    const content = 'name: pii_filter\nisActive: true\n';
    const files = new Map<string, string>();
    files.set('guardrails/pii_filter.guardrail.yaml', content);

    const lockfile = makeLockfileWithSections({
      guardrails: { pii_filter: { source_hash: computeHash(content) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.guardrails.valid).toBe(true);
  });

  it('should match workflows section → workflows/{name}.workflow.json', () => {
    const content = '{"steps": []}';
    const files = new Map<string, string>();
    files.set('workflows/onboarding.workflow.json', content);

    const lockfile = makeLockfileWithSections({
      workflows: { onboarding: { source_hash: computeHash(content) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.workflows.valid).toBe(true);
  });

  it('should match evals section → evals/{name}/eval-set.json', () => {
    const content = '{"cases": []}';
    const files = new Map<string, string>();
    files.set('evals/accuracy/eval-set.json', content);

    const lockfile = makeLockfileWithSections({
      evals: { accuracy: { source_hash: computeHash(content) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.evals.valid).toBe(true);
  });

  it('should match evals section → evals/evaluators/{name}.evaluator.json', () => {
    const content = '{"evaluator": "quality"}';
    const files = new Map<string, string>();
    files.set('evals/evaluators/quality.evaluator.json', content);

    const lockfile = makeLockfileWithSections({
      evals: { quality: { source_hash: computeHash(content) } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.evals.valid).toBe(true);
  });

  it('should match search section via direct file-path keys (v2 lockfile format)', () => {
    const idxContent = '{"index": true}';
    const srcContent = '{"source": true}';
    const kbContent = '{"kb": true}';
    const files = new Map<string, string>();
    // These are the actual extensions produced by SearchAssembler
    files.set('search/indexes/products.index.json', idxContent);
    files.set('search/sources/web.source.json', srcContent);
    files.set('search/knowledge-bases/docs.kb.json', kbContent);

    // v2 lockfile uses full file paths as keys for non-agent sections
    const lockfile = makeLockfileWithSections({
      search: {
        'search/indexes/products.index.json': { source_hash: computeHash(idxContent) },
        'search/sources/web.source.json': { source_hash: computeHash(srcContent) },
        'search/knowledge-bases/docs.kb.json': { source_hash: computeHash(kbContent) },
      },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.search.valid).toBe(true);
    expect(result.layerResults.search.mismatchedFiles).toHaveLength(0);
  });

  it('should match search section via name-based fallback patterns', () => {
    const idxContent = '{"index": true}';
    const srcContent = '{"source": true}';
    const kbContent = '{"kb": true}';
    const files = new Map<string, string>();
    files.set('search/indexes/products.index.json', idxContent);
    files.set('search/sources/web.source.json', srcContent);
    files.set('search/knowledge-bases/docs.kb.json', kbContent);

    // Short-name keys (fallback path for legacy lockfiles)
    const lockfile = makeLockfileWithSections({
      search: {
        products: { source_hash: computeHash(idxContent) },
        web: { source_hash: computeHash(srcContent) },
        docs: { source_hash: computeHash(kbContent) },
      },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.search.valid).toBe(true);
    expect(result.layerResults.search.mismatchedFiles).toHaveLength(0);
  });

  it('should match channels section — channel, webhook, widget', () => {
    const chContent = '{"type": "web"}';
    const whContent = '{"url": "https://hook"}';
    const wdContent = '{"widget": true}';
    const files = new Map<string, string>();
    files.set('channels/web.channel.json', chContent);
    files.set('channels/webhooks/notify.webhook.json', whContent);
    files.set('channels/widgets/chat.widget.json', wdContent);

    const lockfile = makeLockfileWithSections({
      channels: {
        web: { source_hash: computeHash(chContent) },
        notify: { source_hash: computeHash(whContent) },
        chat: { source_hash: computeHash(wdContent) },
      },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.channels.valid).toBe(true);
  });

  it('should match vocabulary section — lookup, lookup-tables, schemas', () => {
    const lookupContent = '{"entries": []}';
    const tableContent = '{"table": []}';
    const schemaContent = '{"schema": {}}';
    const files = new Map<string, string>();
    files.set('vocabulary/countries.lookup.json', lookupContent);
    files.set('vocabulary/lookup-tables/currencies.lookup.json', tableContent);
    files.set('vocabulary/schemas/address.schema.json', schemaContent);

    const lockfile = makeLockfileWithSections({
      vocabulary: {
        countries: { source_hash: computeHash(lookupContent) },
        currencies: { source_hash: computeHash(tableContent) },
        address: { source_hash: computeHash(schemaContent) },
      },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.vocabulary.valid).toBe(true);
  });

  it('should verify behavior profile entries by direct file path', () => {
    const profileContent = 'BEHAVIOR_PROFILE: voltmart_voice';
    const files = new Map<string, string>();
    files.set('behavior_profiles/voltmart_voice.profile.abl', profileContent);

    const lockfile = makeLockfileWithSections({
      behavior_profiles: {
        'behavior_profiles/voltmart_voice.profile.abl': {
          source_hash: computeHash(profileContent),
        },
      },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.valid).toBe(true);
    expect(result.layerResults.behavior_profiles.valid).toBe(true);
  });

  it('should return null for unknown section — warns about missing file', () => {
    const files = new Map<string, string>();

    // Use a lockfile with a populated section but no corresponding files
    const lockfile = makeLockfileWithSections({
      configs: { mystery: { source_hash: 'abc123' } },
    });
    // Remove the file so it cannot be found
    // (files map is empty, so no config/mystery.json exists)

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.warnings.some((w) => w.includes('mystery') && w.includes('not found'))).toBe(
      true,
    );
  });

  it('should detect hash mismatch for non-agent/tool sections', () => {
    const files = new Map<string, string>();
    files.set('guardrails/pii.guardrail.json', '{"modified": true}');

    const lockfile = makeLockfileWithSections({
      guardrails: { pii: { source_hash: 'stale_hash_value_' } },
    });

    const result = verifySHAIntegrity(lockfile, files);
    expect(result.layerResults.guardrails.valid).toBe(false);
    expect(result.layerResults.guardrails.mismatchedFiles).toContain('pii');
  });
});

// ─── validateImport — behavior profiles and agent name extraction ────────

describe('validateImport — additional coverage', () => {
  it('should validate behavior profile files in agentFiles without treating them as agents', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set(
      'behavior_profiles/formal.behavior_profile.abl',
      'BEHAVIOR_PROFILE: Formal\nPRIORITY: 10\nWHEN: true\nCONVERSATION:\n  speaking:\n    tone: professional',
    );
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    expect(result.syntaxErrors).toHaveLength(0);
  });

  it('should validate manifest-style profile suffixes in agentFiles without agent-header errors', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set(
      'behavior_profiles/formal.profile.abl',
      'BEHAVIOR_PROFILE: Formal\nPRIORITY: 10\nWHEN: true\nCONVERSATION:\n  speaking:\n    tone: professional',
    );
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    expect(result.syntaxErrors).toHaveLength(0);
  });

  it('should only report behavior profile syntax errors for invalid inline profile files', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set('behavior_profiles/bad.profile.abl', 'INVALID_HEADER: oops');
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    expect(result.syntaxErrors).toHaveLength(1);
    expect(
      result.syntaxErrors.some((e) =>
        e.errors.some((err) => err.message.includes('BEHAVIOR_PROFILE')),
      ),
    ).toBe(true);
  });

  it('should report parse errors for malformed behavior profile DSL', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set(
      'behavior_profiles/bad.behavior_profile.abl',
      'BEHAVIOR_PROFILE: Bad\nCONVERSATION:\n  speaking:\n    tone: warm',
    );
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    const profileErrors = result.syntaxErrors
      .filter((entry) => entry.file === 'behavior_profiles/bad.behavior_profile.abl')
      .flatMap((entry) => entry.errors)
      .filter(
        (error) =>
          error.message.includes('requires a PRIORITY: declaration') ||
          error.message.includes('requires a WHEN: declaration'),
      );
    expect(profileErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('requires a PRIORITY: declaration'),
        }),
        expect.objectContaining({
          message: expect.stringContaining('requires a WHEN: declaration'),
        }),
      ]),
    );
  });

  it('should report syntax errors for invalid behavior profile', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set('behavior_profiles/bad.behavior_profile.abl', 'INVALID_HEADER: oops');
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    expect(result.syntaxErrors.length).toBe(1);

    const profileErrors = result.syntaxErrors.filter(
      (e) =>
        e.file === 'behavior_profiles/bad.behavior_profile.abl' &&
        e.errors.some((err) => err.message.includes('BEHAVIOR_PROFILE')),
    );
    expect(profileErrors.length).toBe(1);
  });

  it('should extract agent name from lowercase format', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set('agents/helper.agent.abl', 'agent: Helper\ngoal: Assist users');
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    // Should not have syntax errors — lowercase agent: is valid
    expect(result.syntaxErrors.length).toBe(0);
  });

  it('should extract agent name from supervisor: format', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set('agents/router.agent.abl', 'supervisor: Router\ngoal: Route requests');
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    expect(result.syntaxErrors.length).toBe(0);
  });

  it('should keep hyphenated behavior profile names available for dependency validation', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set(
      'agents/voice.agent.abl',
      'AGENT: VoiceAgent\nUSE BEHAVIOR_PROFILE: voice-optimized\nGOAL: Assist callers',
    );
    const profileFiles = new Map<string, string>();
    profileFiles.set(
      'behavior_profiles/voice_optimized.behavior_profile.abl',
      'BEHAVIOR_PROFILE: voice-optimized\nPRIORITY: 5\nWHEN: channel == "voice"',
    );
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles, profileFiles);

    expect(result.dependencyValidation.valid).toBe(true);
    expect(result.dependencyValidation.missing).toEqual([]);
  });

  it('should fall back to path when content has no matching header', () => {
    const agentFiles = new Map<string, string>();
    agentFiles.set('agents/noheader.agent.abl', 'GOAL: Just chat');
    const toolFiles = new Map<string, string>();

    const result = validateImport(agentFiles, toolFiles);

    // Will have syntax error for missing header
    expect(result.syntaxErrors.length).toBe(1);
    // But the dependency graph should still have an entry using the path as name
    expect(result.valid).toBe(false);
  });
});

// ─── validateCrossLayerDeps — additional coverage ────────────────────────

describe('validateCrossLayerDeps — self-referencing and empty layers', () => {
  it('should handle empty layers with no files at all', () => {
    const files = new Map<string, string>();
    // Provide a minimal agent so readFolderV2 does not error on "No agent files"
    files.set('agents/solo.agent.abl', 'AGENT: Solo\nGOAL: Standalone');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(true);
    expect(result.missingDependencies).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should validate valid cross-layer references with no errors', () => {
    const files = new Map<string, string>();
    files.set(
      'agents/booking.agent.abl',
      'AGENT: Booking\nGOAL: Book hotels\nTOOLS:\n  - hotel_api\n  - payment',
    );
    files.set('tools/hotel_api.tools.abl', 'TOOL: HotelAPI\nCONNECTOR: hotel_service');
    files.set('tools/payment.tools.abl', 'TOOL: Payment\nCONNECTOR: stripe');
    files.set('connections/connectors/hotel_service.connection.json', '{"name": "hotel_service"}');
    files.set('connections/connectors/stripe.connection.json', '{"name": "stripe"}');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(true);
    expect(result.missingDependencies).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should detect missing connector dependency when connections layer has other connectors', () => {
    const files = new Map<string, string>();
    files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Route');
    files.set('tools/crm.tools.abl', 'TOOL: CRM\nCONNECTOR: missing_service');
    // A different connector exists, but not the one referenced
    files.set('connections/connectors/other.connection.json', '{"name": "other_service"}');

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    // Tool references missing_service which is not in the connections layer
    expect(result.warnings.some((w) => w.includes('missing_service'))).toBe(true);
  });

  it('should report multiple missing tool dependencies from a single agent', () => {
    const files = new Map<string, string>();
    files.set(
      'agents/main.agent.abl',
      'AGENT: Main\nGOAL: Do stuff\nTOOLS:\n  - ToolA\n  - ToolB\n  - ToolC',
    );
    // None of the tools exist

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(false);
    expect(result.missingDependencies).toHaveLength(3);
    const targets = result.missingDependencies.map((d) => d.target);
    expect(targets).toContain('ToolA');
    expect(targets).toContain('ToolB');
    expect(targets).toContain('ToolC');
  });

  it('should handle multiple agents with overlapping tool references', () => {
    const files = new Map<string, string>();
    files.set(
      'agents/a1.agent.abl',
      'AGENT: A1\nGOAL: First\nTOOLS:\n  - shared_tool\n  - unique_a',
    );
    files.set(
      'agents/a2.agent.abl',
      'AGENT: A2\nGOAL: Second\nTOOLS:\n  - shared_tool\n  - unique_b',
    );
    files.set('tools/shared_tool.tools.abl', 'TOOL: SharedTool');
    // unique_a and unique_b are missing

    const folderResult = readFolderV2(files);
    const result = validateCrossLayerDeps(folderResult);

    expect(result.valid).toBe(false);
    // Each agent should report its own missing tool
    expect(result.missingDependencies).toHaveLength(2);
    const targets = result.missingDependencies.map((d) => d.target);
    expect(targets).toContain('unique_a');
    expect(targets).toContain('unique_b');
  });
});

// ─── verifySHAIntegrity — direct tamper tests ───────────────────────────

describe('verifySHAIntegrity — tamper detection', () => {
  const agentContent = 'AGENT: TestBot\nGOAL: Test';
  const toolContent = 'TOOL: TestTool';
  const configContent = '{"setting": "value"}';

  function buildFilesAndLockfile() {
    const files = new Map<string, string>();
    files.set('agents/testbot.agent.abl', agentContent);
    files.set('tools/testtool.tools.abl', toolContent);
    files.set('config/app.json', configContent);

    const lockfile = makeLockfileWithSections({
      agents: {
        testbot: {
          version: '1.0',
          source_hash: computeHash(agentContent),
          status: 'active',
        },
      },
      tools: {
        testtool: { source_hash: computeHash(toolContent) },
      },
      configs: {
        app: { source_hash: computeHash(configContent) },
      },
    });

    return { files, lockfile };
  }

  it('should pass when all hashes match (valid lockfile)', () => {
    const { files, lockfile } = buildFilesAndLockfile();
    const result = verifySHAIntegrity(lockfile, files);

    expect(result.valid).toBe(true);
    expect(result.integrityMatch).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.layerResults.agents.valid).toBe(true);
    expect(result.layerResults.tools.valid).toBe(true);
    expect(result.layerResults.configs.valid).toBe(true);
  });

  it('should detect tampered file hash (file content changed)', () => {
    const { files, lockfile } = buildFilesAndLockfile();
    // Tamper with the agent file content after lockfile was generated
    files.set('agents/testbot.agent.abl', 'AGENT: TestBot\nGOAL: Tampered goal');

    const result = verifySHAIntegrity(lockfile, files);

    // Root integrity still matches (lockfile itself is untouched)
    expect(result.integrityMatch).toBe(true);
    // But individual file hash fails
    expect(result.layerResults.agents.valid).toBe(false);
    expect(result.layerResults.agents.mismatchedFiles).toContain('testbot');
    // Overall result is invalid
    expect(result.valid).toBe(false);
  });

  it('should detect tampered layer hash (lockfile entry modified)', () => {
    const { files, lockfile } = buildFilesAndLockfile();
    // Tamper with a source_hash in the lockfile itself
    lockfile.tools.testtool.source_hash = 'aaaaaaaaaaaaaaaa';
    // This also invalidates the root integrity because the lockfile content changed

    const result = verifySHAIntegrity(lockfile, files);

    // Root integrity no longer matches (lockfile was tampered)
    expect(result.integrityMatch).toBe(false);
    expect(result.errors.some((e) => e.includes('integrity hash mismatch'))).toBe(true);
    // The tampered tool entry will also mismatch
    expect(result.layerResults.tools.valid).toBe(false);
    expect(result.layerResults.tools.mismatchedFiles).toContain('testtool');
    expect(result.valid).toBe(false);
  });

  it('should detect tampered root hash directly', () => {
    const { files, lockfile } = buildFilesAndLockfile();
    // Replace the root integrity hash with garbage
    lockfile.integrity = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const result = verifySHAIntegrity(lockfile, files);

    expect(result.integrityMatch).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('integrity hash mismatch');
    // Individual files still match since their hashes are correct
    expect(result.layerResults.agents.valid).toBe(true);
    expect(result.layerResults.tools.valid).toBe(true);
    // But overall result is invalid because root integrity failed
    expect(result.valid).toBe(false);
  });

  it('should handle lockfile with all empty sections gracefully', () => {
    const files = new Map<string, string>();
    const lockfile = makeLockfileWithSections({});

    const result = verifySHAIntegrity(lockfile, files);

    expect(result.valid).toBe(true);
    expect(result.integrityMatch).toBe(true);
    expect(result.errors).toHaveLength(0);
    // All layer results should be valid (empty = no mismatches)
    for (const layerResult of Object.values(result.layerResults)) {
      expect(layerResult.valid).toBe(true);
      expect(layerResult.mismatchedFiles).toHaveLength(0);
    }
  });
});
