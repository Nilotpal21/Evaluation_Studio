/**
 * Lockfile Generator — builds abl.lock with pinned versions and source hashes
 */

import { createHash } from 'crypto';
import type { LockFile, LockFileAgent, LockFileTool, LockFileV2, LayerName } from '../types.js';
import {
  computeProjectAgentDraftArtifactSourceHash,
  type ProjectAgentDraftState,
} from '../project-agent-draft-metadata.js';

export interface LockfileAgentInput {
  name: string;
  version: string;
  dslContent: string;
  status: string;
  systemPromptLibraryRef?: ProjectAgentDraftState['systemPromptLibraryRef'];
}

export interface LockfileToolInput {
  name: string;
  content: string;
}

/**
 * Compute a truncated SHA-256 hash of content.
 * Uses first 16 hex characters (64 bits) for space efficiency.
 */
export function computeSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Generate a lockfile from agent and tool data.
 */
export function generateLockfile(
  agents: LockfileAgentInput[],
  tools: LockfileToolInput[],
): LockFile {
  const agentsRecord: Record<string, LockFileAgent> = {};
  for (const agent of agents) {
    agentsRecord[agent.name] = {
      version: agent.version,
      source_hash:
        computeProjectAgentDraftArtifactSourceHash({
          recordName: agent.name,
          dslContent: agent.dslContent,
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        }) ?? computeSourceHash(agent.dslContent),
      status: agent.status,
    };
  }

  const toolsRecord: Record<string, LockFileTool> = {};
  for (const tool of tools) {
    toolsRecord[tool.name] = {
      source_hash: computeSourceHash(tool.content),
    };
  }

  // Compute integrity hash over the lockfile content (excluding integrity itself)
  // Sort keys for deterministic serialization regardless of insertion order
  const sortedAgents = Object.fromEntries(
    Object.entries(agentsRecord).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sortedTools = Object.fromEntries(
    Object.entries(toolsRecord).sort(([a], [b]) => a.localeCompare(b)),
  );
  const lockContent = JSON.stringify({ agents: sortedAgents, tools: sortedTools });
  const integrity = createHash('sha256').update(lockContent, 'utf8').digest('hex');

  return {
    lockfile_version: '1.0',
    generated_at: new Date().toISOString(),
    agents: agentsRecord,
    tools: toolsRecord,
    integrity,
  };
}

/**
 * Verify lockfile integrity.
 */
export function verifyLockfileIntegrity(lockfile: LockFile): boolean {
  const sortedAgents = Object.fromEntries(
    Object.entries(lockfile.agents).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sortedTools = Object.fromEntries(
    Object.entries(lockfile.tools).sort(([a], [b]) => a.localeCompare(b)),
  );
  const lockContent = JSON.stringify({ agents: sortedAgents, tools: sortedTools });
  const computed = createHash('sha256').update(lockContent, 'utf8').digest('hex');
  return computed === lockfile.integrity;
}

// ─── Lockfile v2: 3-tier SHA ──────────────────────────────────────────────

/** File path prefixes that map to lockfile sections */
const LAYER_FILE_ROUTES: Record<
  string,
  keyof Pick<
    LockFileV2,
    | 'configs'
    | 'connections'
    | 'guardrails'
    | 'workflows'
    | 'evals'
    | 'search'
    | 'channels'
    | 'vocabulary'
    | 'behavior_profiles'
  >
> = {
  'behavior_profiles/': 'behavior_profiles',
  'config/': 'configs',
  'core/': 'configs',
  'connections/': 'connections',
  'guardrails/': 'guardrails',
  'workflows/': 'workflows',
  'evals/': 'evals',
  'search/': 'search',
  'channels/': 'channels',
  'vocabulary/': 'vocabulary',
};

/**
 * Compute a composite hash for all files in a layer.
 * Sorts file paths for deterministic output regardless of insertion order.
 */
export function computeLayerHash(files: Map<string, string>): string {
  const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const content = sorted.map(([path, data]) => `${path}:${computeSourceHash(data)}`).join('\n');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Route a file path to the correct lockfile section.
 */
function routeFile(
  filePath: string,
): 'agents' | 'tools' | keyof typeof LAYER_FILE_ROUTES | 'configs' {
  if (filePath.startsWith('agents/')) return 'agents';
  if (filePath.startsWith('tools/')) return 'tools';
  for (const [prefix, section] of Object.entries(LAYER_FILE_ROUTES)) {
    if (filePath.startsWith(prefix)) return section;
  }
  // Environment files map to configs
  if (filePath.startsWith('environment/')) return 'configs';
  return 'configs';
}

function buildV2IntegrityPayload(lockfile: {
  agents: LockFileV2['agents'];
  tools: LockFileV2['tools'];
  configs: LockFileV2['configs'];
  connections: LockFileV2['connections'];
  guardrails: LockFileV2['guardrails'];
  workflows: LockFileV2['workflows'];
  evals: LockFileV2['evals'];
  search: LockFileV2['search'];
  channels: LockFileV2['channels'];
  vocabulary: LockFileV2['vocabulary'];
  behavior_profiles?: LockFileV2['behavior_profiles'];
  layer_hashes: LockFileV2['layer_hashes'];
}): string {
  const payload: Record<string, unknown> = {
    agents: sortedRecord(lockfile.agents),
    tools: sortedRecord(lockfile.tools),
    configs: sortedRecord(lockfile.configs),
    connections: sortedRecord(lockfile.connections),
    guardrails: sortedRecord(lockfile.guardrails),
    workflows: sortedRecord(lockfile.workflows),
    evals: sortedRecord(lockfile.evals),
    search: sortedRecord(lockfile.search),
    channels: sortedRecord(lockfile.channels),
    vocabulary: sortedRecord(lockfile.vocabulary),
    layer_hashes: sortedRecord(lockfile.layer_hashes as Record<string, string>),
  };

  if (lockfile.behavior_profiles !== undefined) {
    payload.behavior_profiles = sortedRecord(lockfile.behavior_profiles);
  }

  return JSON.stringify(payload);
}

/**
 * Generate a v2 lockfile with 3-tier SHA verification:
 * 1. Per-file source_hash (truncated SHA-256)
 * 2. Per-layer composite layer_hashes (full SHA-256)
 * 3. Root integrity hash over all layer hashes (full SHA-256)
 */
export function generateLockfileV2(
  layerFiles: Map<LayerName, Map<string, string>>,
  agents: LockfileAgentInput[],
): LockFileV2 {
  const agentsRecord: Record<string, { version: string; source_hash: string; status: string }> = {};
  const toolsRecord: Record<string, { source_hash: string }> = {};
  const configsRecord: Record<string, { source_hash: string }> = {};
  const connectionsRecord: Record<string, { source_hash: string }> = {};
  const guardrailsRecord: Record<string, { source_hash: string }> = {};
  const workflowsRecord: Record<
    string,
    { source_hash: string; version?: string; status?: string }
  > = {};
  const evalsRecord: Record<string, { source_hash: string }> = {};
  const searchRecord: Record<string, { source_hash: string }> = {};
  const channelsRecord: Record<string, { source_hash: string }> = {};
  const vocabularyRecord: Record<string, { source_hash: string }> = {};
  const behaviorProfilesRecord: Record<string, { source_hash: string }> = {};

  const sectionMap: Record<string, Record<string, { source_hash: string }>> = {
    tools: toolsRecord,
    configs: configsRecord,
    connections: connectionsRecord,
    guardrails: guardrailsRecord,
    workflows: workflowsRecord,
    evals: evalsRecord,
    search: searchRecord,
    channels: channelsRecord,
    vocabulary: vocabularyRecord,
    behavior_profiles: behaviorProfilesRecord,
  };

  // Tier 1: Per-file hashes — populate agent records from input
  for (const agent of agents) {
    agentsRecord[agent.name] = {
      version: agent.version,
      source_hash:
        computeProjectAgentDraftArtifactSourceHash({
          recordName: agent.name,
          dslContent: agent.dslContent,
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        }) ?? computeSourceHash(agent.dslContent),
      status: agent.status,
    };
  }

  // Route non-agent files to their lockfile section
  for (const [, files] of layerFiles) {
    for (const [filePath, content] of files) {
      const section = routeFile(filePath);
      if (section === 'agents') continue; // Agents handled via LockfileAgentInput
      const target = sectionMap[section];
      if (target) {
        target[filePath] = { source_hash: computeSourceHash(content) };
      }
    }
  }

  // Enrich workflow version entries with version and status metadata
  for (const [filePath, content] of layerFiles.get('workflows' as LayerName) ?? new Map()) {
    if (filePath.endsWith('.version.json') && workflowsRecord[filePath]) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.version) workflowsRecord[filePath].version = parsed.version;
        if (parsed.status) workflowsRecord[filePath].status = parsed.status;
      } catch {
        // Ignore parse errors — source_hash is already computed
      }
    }
  }

  // Tier 2: Per-layer composite hashes
  // All declared layers get a hash entry — even empty layers — so that
  // layers_included in the manifest always has a corresponding layer_hash.
  const layerHashes: Partial<Record<LayerName, string>> = {};
  for (const [layer, files] of layerFiles) {
    layerHashes[layer] = computeLayerHash(files);
  }

  // Tier 3: Root integrity hash over sorted layer hashes + sorted section hashes
  const integrityPayload = buildV2IntegrityPayload({
    agents: sortedRecord(agentsRecord),
    tools: sortedRecord(toolsRecord),
    configs: sortedRecord(configsRecord),
    connections: sortedRecord(connectionsRecord),
    guardrails: sortedRecord(guardrailsRecord),
    workflows: sortedRecord(workflowsRecord),
    evals: sortedRecord(evalsRecord),
    search: sortedRecord(searchRecord),
    channels: sortedRecord(channelsRecord),
    vocabulary: sortedRecord(vocabularyRecord),
    behavior_profiles: sortedRecord(behaviorProfilesRecord),
    layer_hashes: sortedRecord(layerHashes as Record<string, string>),
  });
  const integrity = createHash('sha256').update(integrityPayload, 'utf8').digest('hex');

  return {
    lockfile_version: '2.0',
    generated_at: new Date().toISOString(),
    agents: agentsRecord,
    tools: toolsRecord,
    configs: configsRecord,
    connections: connectionsRecord,
    guardrails: guardrailsRecord,
    workflows: workflowsRecord,
    evals: evalsRecord,
    search: searchRecord,
    channels: channelsRecord,
    vocabulary: vocabularyRecord,
    behavior_profiles: behaviorProfilesRecord,
    layer_hashes: layerHashes,
    integrity,
  };
}

/**
 * Verify v2 lockfile integrity by recomputing the root hash.
 */
export function verifyLockfileV2Integrity(lockfile: LockFileV2): boolean {
  const integrityPayload = buildV2IntegrityPayload({
    agents: sortedRecord(lockfile.agents),
    tools: sortedRecord(lockfile.tools),
    configs: sortedRecord(lockfile.configs),
    connections: sortedRecord(lockfile.connections),
    guardrails: sortedRecord(lockfile.guardrails),
    workflows: sortedRecord(lockfile.workflows),
    evals: sortedRecord(lockfile.evals),
    search: sortedRecord(lockfile.search),
    channels: sortedRecord(lockfile.channels),
    vocabulary: sortedRecord(lockfile.vocabulary),
    behavior_profiles: lockfile.behavior_profiles
      ? sortedRecord(lockfile.behavior_profiles)
      : undefined,
    layer_hashes: sortedRecord(lockfile.layer_hashes as Record<string, string>),
  });
  const computed = createHash('sha256').update(integrityPayload, 'utf8').digest('hex');
  if (computed === lockfile.integrity) {
    return true;
  }

  if (lockfile.behavior_profiles === undefined) {
    return false;
  }

  const legacyIntegrityPayload = buildV2IntegrityPayload({
    agents: sortedRecord(lockfile.agents),
    tools: sortedRecord(lockfile.tools),
    configs: sortedRecord(lockfile.configs),
    connections: sortedRecord(lockfile.connections),
    guardrails: sortedRecord(lockfile.guardrails),
    workflows: sortedRecord(lockfile.workflows),
    evals: sortedRecord(lockfile.evals),
    search: sortedRecord(lockfile.search),
    channels: sortedRecord(lockfile.channels),
    vocabulary: sortedRecord(lockfile.vocabulary),
    layer_hashes: sortedRecord(lockfile.layer_hashes as Record<string, string>),
  });
  const legacyComputed = createHash('sha256').update(legacyIntegrityPayload, 'utf8').digest('hex');
  return legacyComputed === lockfile.integrity;
}
