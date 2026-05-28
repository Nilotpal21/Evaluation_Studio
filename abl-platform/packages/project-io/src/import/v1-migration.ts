/**
 * v1 → v2 Migration Handler
 *
 * Normalizes v1 exports (no format_version or "1.0") into a v2-compatible
 * structure. V2 exports pass through unchanged. Unknown future versions
 * are rejected with an upgrade prompt.
 */

import type { ProjectManifestV2, LayerName, ManifestAgent, ManifestTool } from '../types.js';
import { extractAgentName } from './folder-reader.js';

export interface V1MigrationResult {
  /** Whether migration was applied (true for v1 → v2 conversion) */
  migrated: boolean;
  /** Detected format version from the manifest */
  formatVersion: string;
  /** Normalized v2 manifest */
  manifest: ProjectManifestV2;
  /** Files (passed through, possibly with updated project.json) */
  files: Map<string, string>;
  /** Migration warnings */
  warnings: string[];
  /** Whether lockfile v2 verification should be skipped (v1 lockfiles have different shape) */
  skipLockfileVerification: boolean;
  /** Present when the format cannot be processed */
  error?: { code: string; message: string };
}

const CURRENT_FORMAT_VERSION = '2.0';

/**
 * Compare two dot-separated version strings (e.g. "2.1" vs "2.0").
 * Returns true if `a` is strictly newer than `b`.
 */
function isNewerVersion(a: string, b: string): boolean {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const segA = partsA[i] ?? 0;
    const segB = partsB[i] ?? 0;
    if (segA > segB) return true;
    if (segA < segB) return false;
  }
  return false;
}

/**
 * Detect the format version and migrate v1 exports to v2 structure.
 *
 * - No format_version or "1.0" → treat as v1, core-only with warnings
 * - "2.0" → pass through unchanged
 * - Anything else → reject with upgrade message
 */
export function migrateV1ToV2(files: Map<string, string>): V1MigrationResult {
  const manifestContent = files.get('project.json');

  if (!manifestContent) {
    return autoGenerateManifest(files);
  }

  let rawManifest: Record<string, unknown>;
  try {
    rawManifest = JSON.parse(manifestContent) as Record<string, unknown>;
  } catch {
    return errorResult('INVALID_MANIFEST', 'project.json is not valid JSON');
  }

  const formatVersion =
    typeof rawManifest.format_version === 'string' ? rawManifest.format_version : undefined;

  // v2 — pass through
  if (formatVersion === CURRENT_FORMAT_VERSION) {
    return {
      migrated: false,
      formatVersion: CURRENT_FORMAT_VERSION,
      manifest: rawManifest as unknown as ProjectManifestV2,
      files,
      warnings: [],
      skipLockfileVerification: false,
    };
  }

  // Unknown future version — reject
  if (formatVersion && formatVersion !== '1.0') {
    if (isNewerVersion(formatVersion, CURRENT_FORMAT_VERSION)) {
      return errorResult(
        'UNSUPPORTED_VERSION',
        `Export format v${formatVersion} is not supported — please upgrade Studio/CLI to import format v${formatVersion}`,
      );
    }
  }

  // v1 (no format_version or "1.0") — migrate to v2 core-only
  const agents = (rawManifest.agents ?? {}) as Record<string, unknown>;
  const tools = (rawManifest.tools ?? {}) as Record<string, unknown>;
  const agentCount = Object.keys(agents).length;
  const toolCount = Object.keys(tools).length;

  const v2Manifest: ProjectManifestV2 = {
    format_version: '2.0',
    name: String(rawManifest.name ?? 'Untitled'),
    slug: String(rawManifest.slug ?? 'untitled'),
    description: rawManifest.description != null ? String(rawManifest.description) : null,
    abl_version: String(rawManifest.abl_version ?? '1.0'),
    exported_at: String(rawManifest.exported_at ?? new Date().toISOString()),
    exported_by: String(rawManifest.exported_by ?? 'unknown'),
    entry_agent: rawManifest.entry_agent != null ? String(rawManifest.entry_agent) : null,
    dsl_format: 'yaml' as const,
    layers_included: ['core'] as LayerName[],
    agents: agents as ProjectManifestV2['agents'],
    tools: tools as ProjectManifestV2['tools'],
    behavior_profiles: rawManifest.behavior_profiles as ProjectManifestV2['behavior_profiles'],
    metadata: {
      entity_counts: {
        agents: agentCount,
        tools: toolCount,
      },
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: [],
    },
  };

  // Replace project.json in files with the normalized v2 manifest
  const migratedFiles = new Map(files);
  migratedFiles.set('project.json', JSON.stringify(v2Manifest, null, 2));

  return {
    migrated: true,
    formatVersion: formatVersion ?? '1.0',
    manifest: v2Manifest,
    files: migratedFiles,
    warnings: ['v1 format — configs, connections, workflows not included'],
    skipLockfileVerification: true,
  };
}

/** Maximum agents/tools allowed during auto-generation to prevent unbounded growth */
const MAX_AUTO_GENERATED_AGENTS = 1000;
const MAX_AUTO_GENERATED_TOOLS = 1000;

/**
 * Extract agent name from DSL content. Uses the same parser-backed identity
 * contract as folder import, with a legacy uppercase header fallback.
 */
function extractAgentNameFromDsl(content: string): string | null {
  return extractAgentName(content);
}

/**
 * Extract tool name from .tools.abl DSL content.
 * Expects format: tool_name(params) -> returnType
 */
function extractToolNameFromDsl(content: string): string | null {
  const match = content.match(/^(\w+)\s*\(/m);
  return match ? match[1] : null;
}

/**
 * Auto-generate a v2 manifest when project.json is missing.
 * Scans for agent and tool files, picks first agent alphabetically as entry_agent.
 */
function autoGenerateManifest(files: Map<string, string>): V1MigrationResult {
  const agentEntries: Array<{ name: string; file: string }> = [];
  const toolEntries: Array<{ name: string; file: string }> = [];

  for (const [path, content] of files) {
    if (
      path.startsWith('agents/') &&
      (path.endsWith('.agent.abl') || path.endsWith('.agent.yaml'))
    ) {
      if (agentEntries.length >= MAX_AUTO_GENERATED_AGENTS) continue;
      const name = extractAgentNameFromDsl(content);
      if (name) {
        agentEntries.push({ name, file: path });
      }
    } else if (path.startsWith('tools/') && path.endsWith('.tools.abl')) {
      if (toolEntries.length >= MAX_AUTO_GENERATED_TOOLS) continue;
      const name = extractToolNameFromDsl(content);
      if (name) {
        toolEntries.push({ name, file: path });
      }
    }
  }

  if (agentEntries.length === 0) {
    return errorResult(
      'NO_AGENTS_FOUND',
      'No project.json found and no agent files detected in agents/ directory',
    );
  }

  // Sort alphabetically, pick first as entry_agent
  agentEntries.sort((a, b) => a.name.localeCompare(b.name));
  toolEntries.sort((a, b) => a.name.localeCompare(b.name));

  const agentFilesByName = new Map<string, string[]>();
  for (const entry of agentEntries) {
    const filesForName = agentFilesByName.get(entry.name) ?? [];
    filesForName.push(entry.file);
    agentFilesByName.set(entry.name, filesForName);
  }
  for (const [name, duplicateFiles] of agentFilesByName) {
    if (duplicateFiles.length > 1) {
      return errorResult(
        'DUPLICATE_AGENT_NAME',
        `No project.json found and multiple agent files declare "${name}": ${duplicateFiles.join(', ')}`,
      );
    }
  }

  const agents: Record<string, ManifestAgent> = {};
  for (const entry of agentEntries) {
    agents[entry.name] = {
      path: entry.file,
      owner: null,
      ownerTeam: null,
      description: null,
      version: null,
    };
  }

  const tools: Record<string, ManifestTool> = {};
  for (const entry of toolEntries) {
    tools[entry.name] = {
      path: entry.file,
      owner: null,
    };
  }

  const v2Manifest: ProjectManifestV2 = {
    format_version: '2.0',
    name: 'Untitled',
    slug: 'untitled',
    description: null,
    abl_version: '1.0',
    exported_at: new Date().toISOString(),
    exported_by: 'auto-generated',
    entry_agent: agentEntries[0].name,
    dsl_format: 'yaml',
    layers_included: ['core'] as LayerName[],
    agents,
    tools,
    metadata: {
      entity_counts: {
        agents: agentEntries.length,
        tools: toolEntries.length,
      },
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: [],
    },
  };

  // Add project.json to files
  const updatedFiles = new Map(files);
  updatedFiles.set('project.json', JSON.stringify(v2Manifest, null, 2));

  return {
    migrated: true,
    formatVersion: '2.0',
    manifest: v2Manifest,
    files: updatedFiles,
    warnings: [
      'No project.json found — auto-generated manifest from detected agent/tool files',
      `Entry agent set to "${agentEntries[0].name}" (first alphabetically)`,
    ],
    skipLockfileVerification: true,
  };
}

function errorResult(code: string, message: string): V1MigrationResult {
  return {
    migrated: false,
    formatVersion: 'unknown',
    manifest: {} as ProjectManifestV2,
    files: new Map(),
    warnings: [],
    skipLockfileVerification: false,
    error: { code, message },
  };
}
