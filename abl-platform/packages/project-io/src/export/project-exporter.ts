/**
 * Project Exporter — main orchestrator for exporting projects
 *
 * Loads agents from the provided data, generates folder structure,
 * manifest, and lockfile. Returns the complete export result.
 */

import type {
  ExportOptions,
  ExportOptionsV2,
  ExportResult,
  ExportResultV2,
  ProjectManifest,
  ProjectManifestV2,
  LockFile,
  LockFileV2,
  LayerName,
  LayerAssemblyResult,
  DependencyEdge,
  AgentArchiveFormat,
  ProjectDslFormat,
  ExportDslFormat,
} from '../types.js';
import { LAYER_SIZE_LIMITS } from '../types.js';
import { buildDependencyGraph } from '../dependencies/dependency-graph.js';
import {
  agentFilePath,
  assignCollisionSafePath,
  buildFileMap,
  profileFilePath,
  type AgentFileEntry,
} from './folder-builder.js';
import { generateManifest, type ManifestInput } from './manifest-generator.js';
import { generateManifestV2, type ManifestInputV2 } from './manifest-generator.js';
import {
  generateLockfile,
  generateLockfileV2,
  type LockfileAgentInput,
} from './lockfile-generator.js';
import { exportDeployments, type DeploymentRecord } from './deployment-exporter.js';
import type { LayerAssembler, LayerQueryContext } from './layer-assemblers/types.js';
import { serializeToYAML } from '@abl/language-service';
import { isYamlFormat } from '@abl/core';
import type { AgentPromptLibraryRefSnapshot } from '../agent-companion-metadata.js';

export interface ProjectData {
  name: string;
  slug: string;
  description: string | null;
  entryAgentName: string | null;
  agents: Array<{
    name: string;
    description: string | null;
    dslContent: string;
    ownerId: string | null;
    ownerTeamId: string | null;
    version: string | null;
    status: string;
    systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
  }>;
  toolFiles: Array<{
    name: string;
    path: string;
    content: string;
  }>;
  deployments: DeploymentRecord[];
  /** Locale assets: relative locale path (e.g. "en/_shared.json") -> JSON content */
  locales?: Map<string, string>;
  /** Behavior profiles: name → DSL content */
  profiles?: Map<string, string>;
}

/**
 * Export a project to the canonical folder structure.
 *
 * @param data - All project data needed for export
 * @param options - Export configuration
 * @returns Complete export result with files, manifest, and lockfile
 */
export function exportProject(data: ProjectData, options: ExportOptions): ExportResult {
  const warnings: string[] = [];

  // Validate: must have at least one agent
  if (data.agents.length === 0) {
    return {
      success: false,
      manifest: null,
      files: new Map(),
      lockfile: null,
      warnings: [],
      error: { code: 'NO_AGENTS', message: 'Project has no agents to export' },
    };
  }

  // Build dependency graph
  const agentEntries = data.agents.map((a) => ({
    name: a.name,
    dslContent: a.dslContent,
  }));
  const graph = buildDependencyGraph(agentEntries, data.toolFiles);

  // Detect supervisor / entry agent
  const entryAgent = data.entryAgentName ?? detectEntryAgent(data.agents);
  if (!entryAgent) {
    warnings.push(
      'No entry agent detected. Set project.entryAgentName or define a SUPERVISOR agent.',
    );
  }

  // Build agent file entries
  const requestedDslFormat = options.dslFormat ?? 'source';
  const agentFileEntries: AgentFileEntry[] = data.agents.map((a) => {
    const trimmed = a.dslContent.trimStart();
    return {
      name: a.name,
      dslContent: a.dslContent,
      isSupervisor: trimmed.startsWith('SUPERVISOR:') || trimmed.startsWith('supervisor:'),
      format:
        requestedDslFormat === 'source' ? inferSourceAgentFormat(a.dslContent) : requestedDslFormat,
    };
  });

  const preserveTruthfulSourceFormat = (entry: AgentFileEntry, warningMessage: string): void => {
    const sourceFormat = inferSourceAgentFormat(entry.dslContent);
    entry.format = sourceFormat;
    warnings.push(warningMessage);
  };

  // Convert DSL to YAML format if requested
  if (requestedDslFormat === 'yaml') {
    for (const entry of agentFileEntries) {
      if (!options.compileFn) {
        preserveTruthfulSourceFormat(
          entry,
          `Requested YAML export for agent "${entry.name}" without compiler context — keeping original source format`,
        );
        continue;
      }

      const ir = options.compileFn(entry.dslContent);
      if (ir) {
        entry.dslContent = serializeToYAML(ir);
        entry.format = 'yaml';
      } else {
        preserveTruthfulSourceFormat(
          entry,
          `Failed to compile agent "${entry.name}" to YAML — keeping original source format`,
        );
      }
    }
  }

  // Build tool file entries
  const toolFileEntries = data.toolFiles.map((t) => ({
    name: t.name,
    content: t.content,
  }));

  // Build deployment files
  const deploymentFiles: Map<string, string> = new Map();
  if (options.includeDeployments) {
    let deployments = data.deployments;
    if (options.environments?.length) {
      deployments = deployments.filter((d) => options.environments!.includes(d.environment));
    }
    const exported = exportDeployments(deployments);
    for (const [name, content] of exported) {
      deploymentFiles.set(name, content);
    }
  }

  // Build file map
  const files = buildFileMap(
    agentFileEntries,
    toolFileEntries,
    new Map(), // configs (model overrides, env settings) — empty for now
    deploymentFiles,
    data.locales,
    archiveFormatForBuildFileMap(requestedDslFormat),
    data.profiles,
  );

  // Extract profile metadata for manifest
  const profileManifestEntries = data.profiles
    ? extractProfileManifestEntries(data.profiles, data.agents)
    : undefined;
  const profilePaths = materializeProfilePaths(data.profiles);

  // Compute per-agent manifest paths so they match the actual files produced by buildFileMap.
  // Without this, the manifest defaults to .yaml extension regardless of the agent's resolved format.
  const agentPaths: Record<string, string> = {};
  for (const entry of agentFileEntries) {
    agentPaths[entry.name] = agentFilePath(entry.name, entry.format ?? 'yaml');
  }

  // Generate manifest
  const manifestInput: ManifestInput = {
    projectName: data.name,
    projectSlug: data.slug,
    projectDescription: data.description,
    exportedBy: options.userId,
    entryAgent,
    agents: data.agents.map((a) => ({
      name: a.name,
      description: a.description,
      ownerId: a.ownerId,
      ownerTeamId: a.ownerTeamId,
      version: a.version,
      systemPromptLibraryRef: a.systemPromptLibraryRef ?? null,
    })),
    tools: data.toolFiles.map((t) => ({
      name: t.name,
      ownerId: null,
    })),
    profiles: profileManifestEntries,
    profilePaths,
    edges: graph.edges,
    dslFormat: summarizeExportDslFormat(requestedDslFormat, agentFileEntries),
    agentPaths,
  };
  const manifest = generateManifest(manifestInput);

  // Generate lockfile
  const lockfileAgents: LockfileAgentInput[] = data.agents.map((a) => ({
    name: a.name,
    version: a.version ?? '0.0.0',
    dslContent: a.dslContent,
    status: a.status,
    systemPromptLibraryRef: a.systemPromptLibraryRef ?? null,
  }));
  const lockfileTools = data.toolFiles.map((t) => ({
    name: t.name,
    content: t.content,
  }));
  const lockfile = generateLockfile(lockfileAgents, lockfileTools);

  // Add manifest and lockfile to files
  files.set('project.json', JSON.stringify(manifest, null, 2));
  files.set('abl.lock', JSON.stringify(lockfile, null, 2));

  return {
    success: true,
    manifest,
    files,
    lockfile,
    warnings,
  };
}

function archiveFormatForBuildFileMap(dslFormat: ExportDslFormat): AgentArchiveFormat {
  return dslFormat === 'source' ? 'abl' : dslFormat;
}

function inferSourceAgentFormat(dslContent: string): AgentArchiveFormat {
  return isYamlFormat(dslContent) ? 'yaml' : 'abl';
}

function summarizeExportDslFormat(
  dslFormat: ExportDslFormat,
  agentFileEntries: Array<{ format?: AgentArchiveFormat }>,
): ProjectDslFormat {
  const resolvedFormats = agentFileEntries
    .map((entry) => entry.format)
    .filter(Boolean) as AgentArchiveFormat[];

  if (dslFormat === 'yaml' && resolvedFormats.every((format) => format === 'yaml')) {
    return 'yaml';
  }

  return summarizeProjectDslFormat(resolvedFormats);
}

/**
 * Auto-detect the entry agent from agent DSL content.
 * Returns the first SUPERVISOR agent found, or null.
 */
function detectEntryAgent(agents: Array<{ name: string; dslContent: string }>): string | null {
  for (const agent of agents) {
    const trimmed = agent.dslContent.trimStart();
    if (trimmed.startsWith('SUPERVISOR:') || trimmed.startsWith('supervisor:')) {
      return agent.name;
    }
  }
  return null;
}

const PRIORITY_RE = /^\s*PRIORITY:\s*(\d+)/m;
const WHEN_RE = /^\s*WHEN:\s*(.+)/m;
const USE_PROFILE_RE = /^\s*USE\s+BEHAVIOR_PROFILE:\s*(\S+)/gm;

export interface BehaviorProfileManifestEntry {
  name: string;
  priority: number;
  whenSummary: string;
  usedBy: string[];
}

function materializeProfilePaths(
  profiles?: Map<string, string>,
): Record<string, string> | undefined {
  if (!profiles || profiles.size === 0) {
    return undefined;
  }

  const assignedPaths = new Set<string>();
  const profilePaths: Record<string, string> = {};

  for (const profileName of profiles.keys()) {
    const path = assignCollisionSafePath(profileFilePath(profileName), assignedPaths);
    assignedPaths.add(path);
    profilePaths[profileName] = path;
  }

  return profilePaths;
}

/**
 * Extract profile manifest entries from profile DSL content.
 * Uses lightweight regex extraction — not a full parse.
 */
export function extractProfileManifestEntries(
  profiles: Map<string, string>,
  agents: Array<{ name: string; dslContent: string }>,
): BehaviorProfileManifestEntry[] {
  // Build reverse map: profile name → agents that USE it
  const usedByMap = new Map<string, string[]>();
  for (const agent of agents) {
    const re = new RegExp(USE_PROFILE_RE.source, USE_PROFILE_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(agent.dslContent)) !== null) {
      const profileName = match[1];
      if (!usedByMap.has(profileName)) usedByMap.set(profileName, []);
      usedByMap.get(profileName)!.push(agent.name);
    }
  }

  const entries: BehaviorProfileManifestEntry[] = [];
  for (const [name, dsl] of profiles) {
    const priorityMatch = PRIORITY_RE.exec(dsl);
    const whenMatch = WHEN_RE.exec(dsl);
    entries.push({
      name,
      priority: priorityMatch ? parseInt(priorityMatch[1], 10) : 0,
      whenSummary: whenMatch ? whenMatch[1].trim() : '',
      usedBy: usedByMap.get(name) ?? [],
    });
  }

  return entries;
}

// ─── Export v2 Orchestrator ─────────────────────────────────────────────────

/** Wave 1 layers (always included) */
const WAVE_1_LAYERS: LayerName[] = ['core', 'connections'];
/** Wave 2 layers (optional, assembled after wave 1) */
const WAVE_2_LAYERS: LayerName[] = [
  'prompts',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
];

const CANONICAL_EXPORT_LAYER_ORDER: LayerName[] = [...WAVE_1_LAYERS, ...WAVE_2_LAYERS];

/**
 * Resolve which layers to export based on options and defaults.
 * Core is always included. Other layers follow LAYER_DEFAULTS unless overridden.
 */
export function resolveLayers(requested?: LayerName[]): LayerName[] {
  if (requested && requested.length > 0) {
    const layers = new Set<LayerName>(requested);
    layers.add('core');
    return CANONICAL_EXPORT_LAYER_ORDER.filter((layer) => layers.has(layer));
  }

  return [...CANONICAL_EXPORT_LAYER_ORDER];
}

export interface ExportV2Deps {
  assemblers: Map<LayerName, LayerAssembler>;
  agentData?: Array<{
    name: string;
    version: string;
    dslContent: string;
    status: string;
    systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
  }>;
  toolData?: Array<{
    name: string;
    dslContent: string;
    toolType?: string | null;
  }>;
  edges?: DependencyEdge[];
}

function toolUsesLayer(
  tool: { dslContent: string; toolType?: string | null },
  toolType: string,
): boolean {
  if (tool.toolType === toolType) {
    return true;
  }

  return new RegExp(`^\\s*type\\s*:\\s*["']?${toolType}["']?\\s*$`, 'im').test(tool.dslContent);
}

/**
 * Expand requested/default export layers with layers required by portable tool bindings.
 *
 * A full project archive must not contain core tools whose identity fields point
 * at source-local SearchAI/workflow records without also exporting the portable
 * target records needed for remapping on import.
 */
export function resolveLayersForToolDependencies(
  requested: LayerName[] | undefined,
  tools: Array<{ dslContent: string; toolType?: string | null }>,
): LayerName[] {
  const layers = new Set(resolveLayers(requested));
  if (!layers.has('core')) {
    return [...layers];
  }

  for (const tool of tools) {
    if (toolUsesLayer(tool, 'searchai')) {
      layers.add('search');
    }
    if (toolUsesLayer(tool, 'workflow')) {
      layers.add('workflows');
    }
  }

  return CANONICAL_EXPORT_LAYER_ORDER.filter((layer) => layers.has(layer));
}

function findMissingAssemblers(
  layers: LayerName[],
  assemblers: Map<LayerName, LayerAssembler>,
): LayerName[] {
  return layers.filter((layer) => !assemblers.has(layer));
}

/**
 * Export a project using the v2 layered model.
 *
 * Two-wave assembly: wave 1 (core, connections) always runs first,
 * wave 2 (optional layers) runs in parallel after wave 1 completes.
 */
export async function exportProjectV2(
  options: ExportOptionsV2,
  deps: ExportV2Deps,
  manifestMeta: Omit<ManifestInputV2, 'layers' | 'edges' | 'dslFormat'>,
): Promise<ExportResultV2> {
  const warnings: string[] = [];
  let layers = resolveLayersForToolDependencies(options.layers, deps.toolData ?? []);
  const explicitLayerRequest = Boolean(options.layers && options.layers.length > 0);
  const ctx: LayerQueryContext = {
    projectId: options.projectId,
    tenantId: options.tenantId,
    includeDeployments: options.includeDeployments,
    environments: options.environments,
    dslFormat: options.dslFormat,
    guardrailFormat: options.guardrailFormat,
  };

  const missingAssemblers = explicitLayerRequest
    ? findMissingAssemblers(layers, deps.assemblers)
    : [];
  if (missingAssemblers.length > 0) {
    return {
      success: false,
      manifest: {} as ProjectManifestV2,
      files: new Map(),
      lockfile: {} as LockFileV2,
      warnings: [],
      error: {
        code: 'MISSING_LAYER_ASSEMBLER',
        message: `Missing assembler(s) for requested export layer(s): ${missingAssemblers.join(', ')}`,
      },
    };
  }
  if (!explicitLayerRequest) {
    const skippedLayers = findMissingAssemblers(layers, deps.assemblers);
    if (skippedLayers.length > 0) {
      warnings.push(
        `Skipping default export layer(s) with no registered assembler: ${skippedLayers.join(', ')}`,
      );
      layers = layers.filter((layer) => deps.assemblers.has(layer));
    }
  }

  // ── Detect entry agent (same fallback logic as v1) ──────────────
  let entryAgent = manifestMeta.entryAgent;
  if (!entryAgent && deps.agentData) {
    entryAgent = detectEntryAgent(deps.agentData);
  }
  if (!entryAgent) {
    warnings.push(
      'No entry agent detected. Set project.entryAgentName or define a SUPERVISOR agent.',
    );
  }
  // Override manifestMeta.entryAgent with detected value
  manifestMeta = { ...manifestMeta, entryAgent };

  // ── Size guard check ──────────────────────────────────────────────
  for (const layer of layers) {
    const assembler = deps.assemblers.get(layer);
    if (!assembler) continue;

    const count = await assembler.countEntities(ctx);
    const limit = LAYER_SIZE_LIMITS[layer];
    if (count > limit.max) {
      return {
        success: false,
        manifest: {} as ProjectManifestV2,
        files: new Map(),
        lockfile: {} as LockFileV2,
        warnings: [],
        error: {
          code: 'SIZE_LIMIT_EXCEEDED',
          message: `Layer "${layer}" has ${count} ${limit.entity} (max ${limit.max})`,
        },
      };
    }
  }

  // ── Wave 1: core layers ───────────────────────────────────────────
  const wave1Layers = layers.filter((l) => WAVE_1_LAYERS.includes(l));
  const wave1Results = await assembleWave(wave1Layers, deps.assemblers, ctx);

  for (const result of wave1Results) {
    warnings.push(...result.warnings);
  }

  // ── Wave 2: optional layers ───────────────────────────────────────
  const wave2Layers = layers.filter((l) => WAVE_2_LAYERS.includes(l));
  const wave2Results = await assembleWave(wave2Layers, deps.assemblers, ctx);

  for (const result of wave2Results) {
    warnings.push(...result.warnings);
  }

  // ── Merge all file maps ───────────────────────────────────────────
  const allResults = [...wave1Results, ...wave2Results];
  const mergedFiles = new Map<string, string>();
  const layerFiles = new Map<LayerName, Map<string, string>>();
  const entityCounts: Record<string, number> = {};
  const agentPaths: Record<string, string> = {};
  const toolPaths: Record<string, string> = {};
  const profilePaths: Record<string, string> = {};
  const agentFormats: AgentArchiveFormat[] = [];

  for (const result of allResults) {
    const normalizedFiles = new Map<string, string>();
    for (const [path, content] of result.files) {
      const normalizedContent = typeof content === 'string' ? content : '';
      if (typeof content !== 'string') {
        warnings.push(`Coerced non-string export content for "${path}" to an empty string`);
      }
      normalizedFiles.set(path, normalizedContent);
    }

    layerFiles.set(result.layer, normalizedFiles);
    entityCounts[result.layer] = result.entityCount;
    for (const [path, content] of normalizedFiles) {
      mergedFiles.set(path, content);
    }
    for (const agent of result.metadata?.agents ?? []) {
      agentPaths[agent.name] = agent.path;
      agentFormats.push(agent.format);
    }
    for (const tool of result.metadata?.tools ?? []) {
      toolPaths[tool.name] = tool.path;
    }
    for (const profile of result.metadata?.profiles ?? []) {
      profilePaths[profile.name] = profile.path;
    }
  }

  const actualDslFormat = summarizeProjectDslFormat(agentFormats);

  // ── Generate manifest v2 ──────────────────────────────────────────
  const manifest = generateManifestV2({
    ...manifestMeta,
    entityCounts: {
      ...manifestMeta.entityCounts,
      ...entityCounts,
    },
    layers,
    edges: deps.edges ?? [],
    dslFormat: actualDslFormat,
    agentPaths,
    toolPaths,
    profilePaths,
  });

  // ── Generate lockfile v2 ──────────────────────────────────────────
  const lockfile = generateLockfileV2(layerFiles, deps.agentData ?? []);

  // Add manifest and lockfile to files
  mergedFiles.set('project.json', JSON.stringify(manifest, null, 2));
  mergedFiles.set('abl.lock', JSON.stringify(lockfile, null, 2));

  return {
    success: true,
    manifest,
    files: mergedFiles,
    lockfile,
    warnings,
  };
}

function summarizeProjectDslFormat(formats: AgentArchiveFormat[]): ProjectDslFormat {
  if (formats.length === 0) {
    return 'yaml';
  }

  const uniqueFormats = new Set(formats);
  if (uniqueFormats.size === 1) {
    return uniqueFormats.has('yaml') ? 'yaml' : 'legacy';
  }

  return 'mixed';
}

/**
 * Assemble a wave of layers in parallel.
 */
async function assembleWave(
  layers: LayerName[],
  assemblers: Map<LayerName, LayerAssembler>,
  ctx: LayerQueryContext,
): Promise<LayerAssemblyResult[]> {
  const promises: Promise<LayerAssemblyResult>[] = [];

  for (const layer of layers) {
    const assembler = assemblers.get(layer);
    if (!assembler) {
      throw new Error(`Missing assembler for layer "${layer}"`);
    }
    promises.push(assembler.assemble(ctx));
  }

  return Promise.all(promises);
}
