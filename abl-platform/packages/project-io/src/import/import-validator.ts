/**
 * Import Validator — validates ABL syntax, dependency integrity, and SHA verification for imports
 */

import { createHash } from 'crypto';
import { parseBehaviorProfile } from '@abl/core/parser';
import type {
  DependencyValidation,
  AgentEntry,
  ToolFileEntry,
  LockFileV2,
  LayerName,
} from '../types.js';
import { buildDependencyGraph, validateDependencies } from '../dependencies/dependency-graph.js';
import { extractAgentName, type FolderReadResultV2 } from './folder-reader.js';
import { parseAgentBasedABL } from '@abl/core';
import { guardrailArchivePath } from '../guardrail-projection.js';
import { validateBehaviorProfileSemantics } from '../behavior-profile-validation.js';
import { computeProjectAgentDraftArtifactSourceHash } from '../project-agent-draft-metadata.js';

export interface SyntaxError {
  file: string;
  errors: Array<{ line: number; message: string }>;
}

export interface ImportValidationResult {
  valid: boolean;
  syntaxErrors: SyntaxError[];
  dependencyValidation: DependencyValidation;
}

// ─── SHA Verification Types ─────────────────────────────────────────────

export interface SHAVerificationResult {
  valid: boolean;
  integrityMatch: boolean;
  layerResults: Record<string, { valid: boolean; mismatchedFiles: string[] }>;
  errors: string[];
  warnings: string[];
}

// ─── Cross-Layer Validation Types ───────────────────────────────────────

export interface CrossLayerValidationResult {
  valid: boolean;
  missingDependencies: Array<{
    source: string;
    sourceLayer: LayerName;
    target: string;
    targetLayer: LayerName;
    type: string;
  }>;
  warnings: string[];
}

function findFirstNonCommentLine(lines: string[]): { lineNumber: number; content: string } | null {
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      continue;
    }

    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }

    return {
      lineNumber: index + 1,
      content: trimmed,
    };
  }

  return null;
}

/**
 * Validate imported ABL files for basic syntax and dependency integrity.
 *
 * Performs:
 * 1. Basic ABL syntax checks (has AGENT/SUPERVISOR header)
 * 2. Dependency extraction and graph validation
 */
export function validateImport(
  agentFiles: Map<string, string>,
  toolFiles: Map<string, string>,
  profileFiles?: Map<string, string>,
): ImportValidationResult {
  const syntaxErrors: SyntaxError[] = [];

  // Basic syntax validation
  for (const [path, content] of agentFiles) {
    if (path.startsWith('behavior_profiles/') && path.endsWith('.abl')) {
      continue;
    }
    const errors = validateAgentSyntax(path, content);
    if (errors.length > 0) {
      syntaxErrors.push({ file: path, errors });
    }
  }

  // Validate behavior profile files if present.
  // Profiles may come from a dedicated profileFiles map (folder reader categorizes them
  // separately) or from agentFiles (legacy callers / tests that include them inline).
  const profileSources: Map<string, string>[] = [profileFiles ?? new Map()];
  // Also scan agentFiles for any inline profile paths (backwards compatibility)
  const inlineProfiles = new Map<string, string>();
  for (const [path, content] of agentFiles) {
    if (path.startsWith('behavior_profiles/') && path.endsWith('.abl')) {
      inlineProfiles.set(path, content);
    }
  }
  profileSources.push(inlineProfiles);

  const validatedProfiles = new Set<string>();
  for (const source of profileSources) {
    for (const [path, content] of source) {
      if (validatedProfiles.has(path)) continue;
      validatedProfiles.add(path);
      const profileErrors = validateProfileSyntax(path, content);
      if (profileErrors.length > 0) {
        syntaxErrors.push({ file: path, errors: profileErrors });
      }
    }
  }

  // Build entries for dependency validation
  const agentEntries: AgentEntry[] = [];
  for (const [path, content] of agentFiles) {
    // Fall back to extracting from path, not using the raw path
    const name =
      extractAgentName(content) ??
      (path
        .replace(/^agents\//, '')
        .replace(/\.agent\.(?:abl|yaml)$/, '')
        .replace(/^tools\//, '')
        .replace(/\.tools\.abl$/, '') ||
        path);
    agentEntries.push({ name, dslContent: content, path });
  }

  const toolEntries: ToolFileEntry[] = [];
  for (const [path, content] of toolFiles) {
    const name = path.replace(/^tools\//, '').replace(/\.tools\.abl$/, '');
    toolEntries.push({ name, path, content });
  }

  // Extract profile names from file content (BEHAVIOR_PROFILE: header).
  // Profile names come from the header, not file paths — names are case-sensitive
  // (e.g. file "empathetic_mode.behavior_profile.abl" declares "Empathetic_Mode").
  const profileNames: string[] = [];
  for (const source of profileSources) {
    for (const [, content] of source) {
      const nameMatch = content.match(/^BEHAVIOR_PROFILE:\s*(\S+)/m);
      if (nameMatch) profileNames.push(nameMatch[1]);
    }
  }

  // Validate dependency graph
  const graph = buildDependencyGraph(agentEntries, toolEntries, profileNames);
  const dependencyValidation = validateDependencies(graph);

  const valid = syntaxErrors.length === 0 && dependencyValidation.valid;

  return {
    valid,
    syntaxErrors,
    dependencyValidation,
  };
}

/**
 * Basic ABL syntax check — verifies the file has a valid header and structure.
 * Supports both legacy (AGENT:/SUPERVISOR:) and YAML (agent:/supervisor:) formats.
 */
export function validateAgentSyntax(
  path: string,
  content: string,
): Array<{ line: number; message: string }> {
  const errors: Array<{ line: number; message: string }> = [];
  const lines = content.split('\n');

  if (lines.length === 0 || content.trim() === '') {
    errors.push({ line: 1, message: 'File is empty' });
    return errors;
  }

  const firstMeaningfulLine = findFirstNonCommentLine(lines);
  if (!firstMeaningfulLine) {
    errors.push({
      line: 1,
      message: 'Missing AGENT:, SUPERVISOR:, agent:, or supervisor: header',
    });
    return errors;
  }

  if (path.endsWith('.agent.yaml')) {
    const parseResult = parseAgentBasedABL(content);
    if (parseResult.document?.name && parseResult.errors.length === 0) {
      return errors;
    }

    for (const error of parseResult.errors) {
      errors.push({
        line: error.line > 0 ? error.line : firstMeaningfulLine.lineNumber,
        message: error.message,
      });
    }

    if (errors.length > 0) {
      return errors;
    }
  }

  if (!firstMeaningfulLine.content.match(/^(?:AGENT|SUPERVISOR|agent|supervisor):\s+\S+/)) {
    errors.push({
      line: firstMeaningfulLine.lineNumber,
      message:
        'Expected AGENT:, SUPERVISOR:, agent:, or supervisor: header as first non-comment line',
    });
  }

  return errors;
}

/**
 * Basic syntax check for behavior profile files.
 * Verifies the file has a BEHAVIOR_PROFILE: header section.
 */
export function validateProfileSyntax(
  _path: string,
  content: string,
): Array<{ line: number; message: string }> {
  const errors: Array<{ line: number; message: string }> = [];
  const lines = content.split('\n');

  if (lines.length === 0 || content.trim() === '') {
    errors.push({ line: 1, message: 'File is empty' });
    return errors;
  }

  const firstMeaningfulLine = findFirstNonCommentLine(lines);
  if (!firstMeaningfulLine) {
    errors.push({ line: 1, message: 'Missing BEHAVIOR_PROFILE: header' });
    return errors;
  }

  if (!firstMeaningfulLine.content.match(/^BEHAVIOR_PROFILE:\s+\S+/i)) {
    errors.push({
      line: firstMeaningfulLine.lineNumber,
      message: 'Expected BEHAVIOR_PROFILE: header as first non-comment line',
    });
    return errors;
  }

  const parseErrors: Array<{ line: number; column: number; message: string }> = [];
  parseBehaviorProfile(lines, 0, parseErrors);

  for (const error of parseErrors) {
    errors.push({
      line: error.line + 1,
      message: error.message,
    });
  }

  if (errors.length > 0) {
    return errors;
  }

  const semanticResult = validateBehaviorProfileSemantics(content);
  for (const message of semanticResult.compilationErrors) {
    errors.push({
      line: firstMeaningfulLine.lineNumber,
      message,
    });
  }

  return errors;
}

// ─── SHA Verification (v2) ──────────────────────────────────────────────

/** Sort record keys for deterministic JSON serialization */
function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Compute a truncated SHA-256 hash matching the lockfile generator format.
 */
function computeSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function buildIntegrityPayload(
  lockfile: LockFileV2,
  options: { includeBehaviorProfiles: boolean },
): string {
  const payload: Record<string, unknown> = {
    agents: sortRecord(lockfile.agents ?? {}),
    tools: sortRecord(lockfile.tools ?? {}),
    configs: sortRecord(lockfile.configs ?? {}),
    connections: sortRecord(lockfile.connections ?? {}),
    guardrails: sortRecord(lockfile.guardrails ?? {}),
    workflows: sortRecord(lockfile.workflows ?? {}),
    evals: sortRecord(lockfile.evals ?? {}),
    search: sortRecord(lockfile.search ?? {}),
    channels: sortRecord(lockfile.channels ?? {}),
    vocabulary: sortRecord(lockfile.vocabulary ?? {}),
    layer_hashes: sortRecord((lockfile.layer_hashes ?? {}) as Record<string, string>),
  };

  if (options.includeBehaviorProfiles) {
    payload.behavior_profiles = sortRecord(lockfile.behavior_profiles ?? {});
  }

  return JSON.stringify(payload);
}

function parseManifestAgentCompanions(
  files: Map<string, string>,
): Map<string, { promptId: string; versionId: string; resolvedHash?: string } | null> {
  const manifestContent = files.get('project.json');
  if (!manifestContent) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(manifestContent) as {
      agents?: Record<
        string,
        {
          systemPromptLibraryRef?: {
            promptId: string;
            versionId: string;
            resolvedHash?: string;
          } | null;
        }
      >;
    };

    return new Map(
      Object.entries(parsed.agents ?? {}).map(([agentName, meta]) => [
        agentName,
        meta.systemPromptLibraryRef ?? null,
      ]),
    );
  } catch {
    return new Map();
  }
}

/**
 * Verify 3-tier SHA integrity of a v2 import.
 *
 * Tier 1: Root integrity hash — fast reject if corrupted
 * Tier 2: Per-layer hashes — skip unchanged layers
 * Tier 3: Per-file source hashes — pinpoint what changed
 */
export function verifySHAIntegrity(
  lockfile: LockFileV2,
  files: Map<string, string>,
): SHAVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const layerResults: Record<string, { valid: boolean; mismatchedFiles: string[] }> = {};
  const manifestAgentCompanions = parseManifestAgentCompanions(files);

  // Tier 1: Root integrity — recompute using the same algorithm as generateLockfileV2()
  // Must match the exact field order and structure from lockfile-generator.ts
  const hasBehaviorProfileSection = lockfile.behavior_profiles !== undefined;
  const integrityPayload = buildIntegrityPayload(lockfile, {
    includeBehaviorProfiles: hasBehaviorProfileSection,
  });
  const computedIntegrity = createHash('sha256').update(integrityPayload, 'utf8').digest('hex');
  const legacyIntegrityPayload = buildIntegrityPayload(lockfile, {
    includeBehaviorProfiles: false,
  });
  const legacyComputedIntegrity = createHash('sha256')
    .update(legacyIntegrityPayload, 'utf8')
    .digest('hex');
  const integrityMatch =
    computedIntegrity === lockfile.integrity || legacyComputedIntegrity === lockfile.integrity;

  if (!integrityMatch) {
    errors.push('Root integrity hash mismatch — lockfile may be corrupted or tampered');
  }

  // Tier 2 & 3: Per-layer and per-file verification
  const layerSections: Array<{ layer: string; entries: Record<string, { source_hash: string }> }> =
    [
      { layer: 'agents', entries: lockfile.agents ?? {} },
      { layer: 'tools', entries: lockfile.tools ?? {} },
      { layer: 'configs', entries: lockfile.configs ?? {} },
      { layer: 'connections', entries: lockfile.connections ?? {} },
      { layer: 'guardrails', entries: lockfile.guardrails ?? {} },
      { layer: 'workflows', entries: lockfile.workflows ?? {} },
      { layer: 'evals', entries: lockfile.evals ?? {} },
      { layer: 'search', entries: lockfile.search ?? {} },
      { layer: 'channels', entries: lockfile.channels ?? {} },
      { layer: 'vocabulary', entries: lockfile.vocabulary ?? {} },
      { layer: 'behavior_profiles', entries: lockfile.behavior_profiles ?? {} },
    ];

  for (const { layer, entries } of layerSections) {
    const mismatchedFiles: string[] = [];

    for (const [name, meta] of Object.entries(entries)) {
      // Find matching file in the file map
      const matchingFile = findFileForEntry(layer, name, files);
      if (!matchingFile) {
        warnings.push(`${layer}/${name}: file not found in import — may have been removed`);
        continue;
      }

      const computed =
        layer === 'agents'
          ? (computeProjectAgentDraftArtifactSourceHash({
              recordName: name,
              dslContent: matchingFile,
              systemPromptLibraryRef: manifestAgentCompanions.get(name) ?? null,
            }) ?? computeSourceHash(matchingFile))
          : computeSourceHash(matchingFile);
      if (computed !== meta.source_hash) {
        mismatchedFiles.push(name);
      }
    }

    layerResults[layer] = {
      valid: mismatchedFiles.length === 0,
      mismatchedFiles,
    };

    if (mismatchedFiles.length > 0) {
      warnings.push(
        `${layer}: ${mismatchedFiles.length} file(s) have changed since export: ${mismatchedFiles.join(', ')}`,
      );
    }
  }

  const allLayersValid = Object.values(layerResults).every((r) => r.valid);

  return {
    valid: integrityMatch && allLayersValid,
    integrityMatch,
    layerResults,
    errors,
    warnings,
  };
}

/**
 * Find a file in the import file map that corresponds to a lockfile entry.
 *
 * The lockfile v2 generator stores non-agent entries using full file paths as keys
 * (e.g., `tools/booking_api.tools.abl`, `search/indexes/products.index.json`).
 * Agent entries use short names (e.g., `supervisor`).
 *
 * We first try a direct lookup by key (covers path-keyed entries), then fall back
 * to name-based pattern matching for agents and legacy lockfiles.
 */
function findFileForEntry(
  section: string,
  name: string,
  files: Map<string, string>,
): string | null {
  // Direct lookup — v2 lockfile uses full file paths as keys for non-agent sections
  const direct = files.get(name);
  if (direct !== undefined) return direct;

  // Name-based pattern matching fallback (agents always use short names)
  const pathPatterns: Record<string, string[]> = {
    agents: [
      `agents/${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.agent.yaml`,
      `agents/${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.agent.abl`,
    ],
    tools: [`tools/${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.tools.abl`],
    configs: [`config/${name}.json`, `core/mcp-servers/${name}.mcp-config.json`],
    connections: [`connections/connectors/${name}.connection.json`],
    guardrails: [guardrailArchivePath(name, 'json'), guardrailArchivePath(name, 'yaml')],
    workflows: [`workflows/${name}.workflow.json`],
    evals: [`evals/${name}/eval-set.json`, `evals/evaluators/${name}.evaluator.json`],
    search: [
      `search/indexes/${name}.index.json`,
      `search/sources/${name}.source.json`,
      `search/knowledge-bases/${name}.kb.json`,
    ],
    channels: [
      `channels/${name}.channel.json`,
      `channels/webhooks/${name}.webhook.json`,
      `channels/widgets/${name}.widget.json`,
    ],
    vocabulary: [
      `vocabulary/${name}.lookup.json`,
      `vocabulary/lookup-tables/${name}.lookup.json`,
      `vocabulary/schemas/${name}.schema.json`,
    ],
    behavior_profiles: [
      `behavior_profiles/${name}.profile.abl`,
      `behavior_profiles/${name}.behavior_profile.abl`,
    ],
  };

  const patterns = pathPatterns[section] ?? [];
  for (const pattern of patterns) {
    const content = files.get(pattern);
    if (content !== undefined) return content;
  }

  return null;
}

// ─── Cross-Layer Dependency Validation (v2) ─────────────────────────────

/**
 * Validate cross-layer dependencies in a v2 import.
 *
 * Checks that:
 * - Agents referencing tools have those tools present
 * - Tools referencing connectors have those connectors present
 * - DSL-authoritative: parses DSL content for actual dependencies
 */
export function validateCrossLayerDeps(
  folderResult: FolderReadResultV2,
): CrossLayerValidationResult {
  const missingDependencies: CrossLayerValidationResult['missingDependencies'] = [];
  const warnings: string[] = [];

  // Extract connector names from connection files
  const availableConnectors = new Set<string>();
  for (const [path, content] of folderResult.connectionFiles) {
    try {
      const parsed = JSON.parse(content);
      const name =
        parsed.name ??
        parsed.connectorName ??
        path
          .split('/')
          .pop()
          ?.replace(/\.connection\.json$/, '');
      if (name) availableConnectors.add(name);
    } catch {
      // Skip unparseable files
    }
  }

  // Extract tool names from tool files (case-insensitive for matching)
  const availableTools = new Set<string>();
  for (const [path, content] of folderResult.toolFiles) {
    const name = path.replace(/^tools\//, '').replace(/\.tools\.abl$/, '');
    availableTools.add(name.toLowerCase());

    // Check if tool DSL references connectors
    const connectorRefs = extractConnectorRefs(content);
    for (const ref of connectorRefs) {
      if (!availableConnectors.has(ref)) {
        missingDependencies.push({
          source: name,
          sourceLayer: 'core',
          target: ref,
          targetLayer: 'connections',
          type: 'connector_import',
        });
      }
      if (!availableConnectors.has(ref) && folderResult.connectionFiles.size > 0) {
        warnings.push(
          `Tool "${name}" references connector "${ref}" which is not in the connections layer`,
        );
      }
    }
  }

  // Check agent DSL references to tools
  for (const [path, content] of folderResult.agentFiles) {
    const agentName = extractAgentName(content) ?? path;
    const toolRefs = extractToolRefs(content);
    for (const ref of toolRefs) {
      if (!availableTools.has(ref.toLowerCase())) {
        missingDependencies.push({
          source: agentName,
          sourceLayer: 'core',
          target: ref,
          targetLayer: 'core',
          type: 'tool_import',
        });
      }
    }
  }

  return {
    valid: missingDependencies.length === 0,
    missingDependencies,
    warnings,
  };
}

/**
 * Extract tool references from agent DSL content.
 * Looks for TOOLS: section and USE: directives.
 */
function extractToolRefs(dslContent: string): string[] {
  const refs: string[] = [];

  // Match TOOLS: section entries (e.g., "  - BookingAPI")
  const toolsSectionMatch = dslContent.match(/^TOOLS:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (toolsSectionMatch) {
    const entries = toolsSectionMatch[1].matchAll(/^\s+-\s+(\S+)/gm);
    for (const entry of entries) {
      refs.push(entry[1]);
    }
  }

  // Match USE: directives
  const useMatches = dslContent.matchAll(/^USE:\s+(\S+)/gm);
  for (const match of useMatches) {
    refs.push(match[1]);
  }

  return refs;
}

/**
 * Extract connector references from tool DSL content.
 * Looks for CONNECTOR: directives.
 */
function extractConnectorRefs(dslContent: string): string[] {
  const refs: string[] = [];
  const matches = dslContent.matchAll(/^CONNECTOR:\s+(\S+)/gm);
  for (const match of matches) {
    refs.push(match[1]);
  }
  return refs;
}
