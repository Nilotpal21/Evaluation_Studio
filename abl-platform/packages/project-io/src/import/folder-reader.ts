/**
 * Folder Reader — reads and validates the canonical export folder structure
 */

import type {
  ProjectManifest,
  LockFile,
  ProjectManifestV2,
  LockFileV2,
  LayerName,
} from '../types.js';
import { isYamlFormat, parseAgentBasedABL } from '@abl/core';
import { normalizeLocaleAssetRelativePath } from '../locale-files.js';
import { isGuardrailArchivePath } from '../guardrail-projection.js';
import { isPromptBundleFilePath } from '../prompt-library-io.js';
import { extractBehaviorProfileNameFromDsl } from '../behavior-profile-files.js';

export interface FolderValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface FolderReadResult {
  success: boolean;
  manifest: ProjectManifest | null;
  lockfile: LockFile | null;
  agentFiles: Map<string, string>;
  toolFiles: Map<string, string>;
  configFiles: Map<string, string>;
  deploymentFiles: Map<string, string>;
  localeFiles: Map<string, string>;
  profileFiles: Map<string, string>;
  errors: string[];
  validationIssues: FolderValidationIssue[];
}

export interface FolderReadResultV2 extends FolderReadResult {
  promptFiles: Map<string, string>;
  connectionFiles: Map<string, string>;
  formatVersion: '1.0' | '2.0';
  manifestV2: ProjectManifestV2 | null;
  lockfileV2: LockFileV2 | null;
  warnings: string[];
  environmentFiles: Map<string, string>;
  guardrailFiles: Map<string, string>;
  workflowFiles: Map<string, string>;
  workflowVersionFiles: Map<string, string>;
  evalFiles: Map<string, string>;
  searchFiles: Map<string, string>;
  channelFiles: Map<string, string>;
  vocabularyFiles: Map<string, string>;
  layerFiles: Record<LayerName, Map<string, string>>;
}

export function getManifestBehaviorProfilePaths(
  manifest: ProjectManifest | ProjectManifestV2 | null,
): Set<string> {
  const paths = new Set<string>();

  for (const profile of Object.values(manifest?.behavior_profiles ?? {})) {
    if (
      profile &&
      typeof profile === 'object' &&
      !Array.isArray(profile) &&
      typeof profile.path === 'string' &&
      profile.path.trim().length > 0
    ) {
      paths.add(profile.path.trim());
    }
  }

  return paths;
}

export function isBehaviorProfileImportPath(
  path: string,
  manifestProfilePaths: ReadonlySet<string> = new Set(),
): boolean {
  return (
    path.startsWith('behavior_profiles/') &&
    (path.endsWith('.behavior_profile.abl') || manifestProfilePaths.has(path))
  );
}

function validateManifestBehaviorProfilePaths(input: {
  files: Map<string, string>;
  manifest: ProjectManifest | ProjectManifestV2 | null;
  errors: string[];
  validationIssues: FolderValidationIssue[];
}): void {
  const behaviorProfiles = input.manifest?.behavior_profiles;
  if (behaviorProfiles === undefined) {
    return;
  }

  if (
    !behaviorProfiles ||
    typeof behaviorProfiles !== 'object' ||
    Array.isArray(behaviorProfiles)
  ) {
    const message =
      'project.json: behavior_profiles must be an object whose values declare a non-empty path';
    input.validationIssues.push({
      code: 'E_BEHAVIOR_PROFILE_INVALID_PATH',
      path: 'project.json',
      message,
    });
    input.errors.push(message);
    return;
  }

  for (const [name, profile] of Object.entries(behaviorProfiles)) {
    if (
      !profile ||
      typeof profile !== 'object' ||
      Array.isArray(profile) ||
      typeof profile.path !== 'string' ||
      profile.path.trim().length === 0
    ) {
      const message =
        `project.json: Behavior profile "${name}" must declare a non-empty path. ` +
        'Expected behavior_profiles/<file>.abl';
      input.validationIssues.push({
        code: 'E_BEHAVIOR_PROFILE_INVALID_PATH',
        path: `behavior_profiles.${name}`,
        message,
      });
      input.errors.push(message);
      continue;
    }

    const path = profile.path.trim();
    if (!path.startsWith('behavior_profiles/') || !path.endsWith('.abl')) {
      const message =
        `project.json: Behavior profile path "${path}" is invalid. ` +
        'Expected behavior_profiles/<file>.abl';
      input.validationIssues.push({
        code: 'E_BEHAVIOR_PROFILE_INVALID_PATH',
        path,
        message,
      });
      input.errors.push(message);
      continue;
    }

    if (!input.files.has(path)) {
      const message = `project.json: Behavior profile path "${path}" was declared but no matching archive file was found`;
      input.validationIssues.push({
        code: 'E_BEHAVIOR_PROFILE_MISSING_PATH',
        path,
        message,
      });
      input.errors.push(message);
    }
  }
}

/**
 * Read and validate a canonical folder structure from a file map.
 *
 * @param files - Map of relativePath → content (from upload or git pull)
 * @returns Parsed folder contents with validation
 */
export function readFolder(files: Map<string, string>): FolderReadResult {
  const errors: string[] = [];
  const validationIssues: FolderValidationIssue[] = [];
  const agentFiles = new Map<string, string>();
  const toolFiles = new Map<string, string>();
  const configFiles = new Map<string, string>();
  const deploymentFiles = new Map<string, string>();
  const localeFiles = new Map<string, string>();
  const profileFiles = new Map<string, string>();

  let manifest: ProjectManifest | null = null;
  let manifestForProfilePaths: ProjectManifest | ProjectManifestV2 | null = null;
  let lockfile: LockFile | null = null;

  // Parse project.json
  const manifestContent = files.get('project.json');
  if (manifestContent) {
    try {
      const parsed = JSON.parse(manifestContent);
      // Skip v2 manifests — they use different field names (project_name vs name)
      // and will fail v1 validation. Leave manifest null so the importer
      // falls back to extracting agent names from DSL headers.
      if (parsed.format_version !== '2.0') {
        manifest = parsed as ProjectManifest;
      }
      manifestForProfilePaths = parsed as ProjectManifest | ProjectManifestV2;
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown parse error';
      errors.push(`project.json: Invalid JSON — ${detail}`);
    }
  }
  // project.json is optional — importers handle null manifests by
  // extracting agent names from DSL headers

  // Parse abl.lock
  const lockContent = files.get('abl.lock');
  if (lockContent) {
    try {
      lockfile = JSON.parse(lockContent);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown parse error';
      errors.push(`abl.lock: Invalid JSON — ${detail}`);
    }
  }
  // lockfile is optional

  const manifestProfilePaths = getManifestBehaviorProfilePaths(manifestForProfilePaths);
  validateManifestBehaviorProfilePaths({
    files,
    manifest: manifestForProfilePaths,
    errors,
    validationIssues,
  });

  // Categorize files
  for (const [path, content] of files) {
    if (path === 'project.json' || path === 'abl.lock') continue;

    if (
      path.startsWith('agents/') &&
      (path.endsWith('.agent.abl') || path.endsWith('.agent.yaml'))
    ) {
      agentFiles.set(path, content);
    } else if (path.startsWith('tools/') && path.endsWith('.tools.abl')) {
      toolFiles.set(path, content);
    } else if (path.startsWith('config/') || path.startsWith('core/')) {
      configFiles.set(path, content);
    } else if (path.startsWith('deployments/') && path.endsWith('.deployment.json')) {
      deploymentFiles.set(path, content);
    } else if (path.startsWith('locales/') && path.endsWith('.json')) {
      const relativePath = normalizeLocaleAssetRelativePath(path);
      if (!relativePath) {
        const message =
          `Locale file path "${path}" is invalid. ` + 'Expected locales/<locale>/<file>.json';
        validationIssues.push({
          code: 'E_LOCALE_INVALID_PATH',
          path,
          message,
        });
        errors.push(message);
      } else {
        localeFiles.set(path, content);
      }
    } else if (isBehaviorProfileImportPath(path, manifestProfilePaths)) {
      profileFiles.set(path, content);
    }
  }

  if (agentFiles.size === 0) {
    errors.push('No agent files found in agents/ directory');
  }

  return {
    success: errors.length === 0,
    manifest,
    lockfile,
    agentFiles,
    toolFiles,
    configFiles,
    deploymentFiles,
    localeFiles,
    profileFiles,
    errors,
    validationIssues,
  };
}

/**
 * Extract agent name from file content.
 * Handles both legacy ABL and YAML through the canonical parser.
 */
export function extractAgentName(content: string): string | null {
  const parseResult = parseAgentBasedABL(content);
  if (parseResult.document?.name) {
    return parseResult.document.name;
  }

  const scalarHeaderMatch = content.match(
    /^\s*(?:AGENT|SUPERVISOR|agent|supervisor):[^\S\r\n]*(.+)[^\S\r\n]*$/m,
  );
  const scalarHeaderName = normalizeNameScalar(scalarHeaderMatch?.[1]);
  if (scalarHeaderName) {
    return scalarHeaderName;
  }

  if (isYamlFormat(content)) {
    return null;
  }

  const fallbackHeaderMatch = content.match(/^\s*name:[^\S\r\n]*(.+)[^\S\r\n]*$/m);
  const scalarName = normalizeNameScalar(fallbackHeaderMatch?.[1]);
  if (scalarName) {
    return scalarName;
  }

  return null;
}

function normalizeNameScalar(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closingIndex = value.indexOf(quote, 1);
    return closingIndex > 0 ? value.slice(1, closingIndex) : value.slice(1);
  }

  return value.split('#')[0]?.trim() || null;
}

/**
 * Read and validate a v2 canonical folder structure from a file map.
 * Supports both v2 (format_version 2.0) and v1 manifests with auto-detection.
 * V1 manifests produce a warning and set formatVersion to '1.0'.
 *
 * @param files - Map of relativePath -> content (from upload or git pull)
 * @returns Parsed folder contents with v2 layer categorization
 */
export function readFolderV2(files: Map<string, string>): FolderReadResultV2 {
  const errors: string[] = [];
  const validationIssues: FolderValidationIssue[] = [];
  const warnings: string[] = [];
  const agentFiles = new Map<string, string>();
  const toolFiles = new Map<string, string>();
  const configFiles = new Map<string, string>();
  const deploymentFiles = new Map<string, string>();
  const localeFiles = new Map<string, string>();
  const profileFiles = new Map<string, string>();
  const connectionFiles = new Map<string, string>();
  const promptFiles = new Map<string, string>();
  const environmentFiles = new Map<string, string>();
  const guardrailFiles = new Map<string, string>();
  const workflowFiles = new Map<string, string>();
  const workflowVersionFiles = new Map<string, string>();
  const evalFiles = new Map<string, string>();
  const searchFiles = new Map<string, string>();
  const channelFiles = new Map<string, string>();
  const vocabularyFiles = new Map<string, string>();

  let manifest: ProjectManifest | null = null;
  let manifestV2: ProjectManifestV2 | null = null;
  let lockfile: LockFile | null = null;
  let lockfileV2: LockFileV2 | null = null;
  let formatVersion: '1.0' | '2.0' = '1.0';

  // Parse project.json
  const manifestContent = files.get('project.json');
  if (manifestContent) {
    try {
      const parsed = JSON.parse(manifestContent);
      if (parsed.format_version === '2.0') {
        formatVersion = '2.0';
        manifestV2 = parsed as ProjectManifestV2;
      } else {
        manifest = parsed as ProjectManifest;
        warnings.push('Detected v1 format — consider re-exporting with format_version 2.0');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown parse error';
      errors.push(`project.json: Invalid JSON — ${detail}`);
    }
  }

  // Parse abl.lock
  const lockContent = files.get('abl.lock');
  if (lockContent) {
    try {
      const parsed = JSON.parse(lockContent);
      if (parsed.lockfile_version === '2.0') {
        lockfileV2 = parsed as LockFileV2;
      } else {
        lockfile = parsed as LockFile;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown parse error';
      errors.push(`abl.lock: Invalid JSON — ${detail}`);
    }
  }

  const manifestProfilePaths = getManifestBehaviorProfilePaths(manifestV2 ?? manifest);
  validateManifestBehaviorProfilePaths({
    files,
    manifest: manifestV2 ?? manifest,
    errors,
    validationIssues,
  });

  // Categorize files into layers
  for (const [path, content] of files) {
    if (path === 'project.json' || path === 'abl.lock') continue;

    if (
      path.startsWith('agents/') &&
      (path.endsWith('.agent.abl') || path.endsWith('.agent.yaml'))
    ) {
      agentFiles.set(path, content);
    } else if (path.startsWith('tools/') && path.endsWith('.tools.abl')) {
      toolFiles.set(path, content);
    } else if (path.startsWith('config/') || path.startsWith('core/')) {
      configFiles.set(path, content);
    } else if (path.startsWith('deployments/') && path.endsWith('.deployment.json')) {
      deploymentFiles.set(path, content);
    } else if (path.startsWith('locales/') && path.endsWith('.json')) {
      const relativePath = normalizeLocaleAssetRelativePath(path);
      if (!relativePath) {
        const message =
          `Locale file path "${path}" is invalid. ` + 'Expected locales/<locale>/<file>.json';
        validationIssues.push({
          code: 'E_LOCALE_INVALID_PATH',
          path,
          message,
        });
        errors.push(message);
      } else {
        localeFiles.set(path, content);
      }
    } else if (isBehaviorProfileImportPath(path, manifestProfilePaths)) {
      profileFiles.set(path, content);
    } else if (isPromptBundleFilePath(path)) {
      promptFiles.set(path, content);
    } else if (path.startsWith('environment/')) {
      environmentFiles.set(path, content);
    } else if (path.startsWith('connections/')) {
      connectionFiles.set(path, content);
    } else if (isGuardrailArchivePath(path)) {
      guardrailFiles.set(path, content);
    } else if (path.startsWith('workflows/versions/') && path.endsWith('.version.json')) {
      workflowVersionFiles.set(path, content);
    } else if (path.startsWith('workflows/')) {
      workflowFiles.set(path, content);
    } else if (path.startsWith('evals/')) {
      evalFiles.set(path, content);
    } else if (path.startsWith('search/')) {
      searchFiles.set(path, content);
    } else if (path.startsWith('channels/')) {
      channelFiles.set(path, content);
    } else if (path.startsWith('vocabulary/')) {
      vocabularyFiles.set(path, content);
    }
  }

  const hasNonAgentImportables =
    toolFiles.size > 0 ||
    configFiles.size > 0 ||
    deploymentFiles.size > 0 ||
    localeFiles.size > 0 ||
    profileFiles.size > 0 ||
    promptFiles.size > 0 ||
    connectionFiles.size > 0 ||
    environmentFiles.size > 0 ||
    guardrailFiles.size > 0 ||
    workflowFiles.size > 0 ||
    workflowVersionFiles.size > 0 ||
    evalFiles.size > 0 ||
    searchFiles.size > 0 ||
    channelFiles.size > 0 ||
    vocabularyFiles.size > 0;

  if (agentFiles.size === 0 && !hasNonAgentImportables) {
    errors.push('No agent files found in agents/ directory');
  }

  // Build core layer aggregate (agents + tools + config + profiles + environment + locales)
  const coreFiles = new Map<string, string>();
  for (const [p, c] of agentFiles) coreFiles.set(p, c);
  for (const [p, c] of toolFiles) coreFiles.set(p, c);
  for (const [p, c] of configFiles) coreFiles.set(p, c);
  for (const [p, c] of profileFiles) coreFiles.set(p, c);
  for (const [p, c] of environmentFiles) coreFiles.set(p, c);
  for (const [p, c] of localeFiles) coreFiles.set(p, c);

  // Merge workflow version files into the workflows layer for lockfile hash consistency
  const workflowLayerFiles = new Map<string, string>();
  for (const [p, c] of workflowFiles) workflowLayerFiles.set(p, c);
  for (const [p, c] of workflowVersionFiles) workflowLayerFiles.set(p, c);

  const layerFiles: Record<LayerName, Map<string, string>> = {
    core: coreFiles,
    connections: connectionFiles,
    prompts: promptFiles,
    guardrails: guardrailFiles,
    workflows: workflowLayerFiles,
    evals: evalFiles,
    search: searchFiles,
    channels: channelFiles,
    vocabulary: vocabularyFiles,
  };

  validateManifestLayerParity({
    manifestV2,
    lockfileV2,
    layerFiles,
    errors,
  });

  return {
    success: errors.length === 0,
    formatVersion,
    manifest,
    manifestV2,
    lockfile,
    lockfileV2,
    agentFiles,
    toolFiles,
    configFiles,
    deploymentFiles,
    localeFiles,
    profileFiles,
    promptFiles,
    connectionFiles,
    environmentFiles,
    guardrailFiles,
    workflowFiles,
    workflowVersionFiles,
    evalFiles,
    searchFiles,
    channelFiles,
    vocabularyFiles,
    layerFiles,
    errors,
    validationIssues,
    warnings,
  };
}

const CANONICAL_LAYER_NAMES: readonly LayerName[] = [
  'core',
  'connections',
  'prompts',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
];

const LAYER_NAME_SET = new Set<string>(CANONICAL_LAYER_NAMES);

const LOCKFILE_LAYER_SECTIONS = {
  connections: ['connections'],
  guardrails: ['guardrails'],
  workflows: ['workflows'],
  evals: ['evals'],
  search: ['search'],
  channels: ['channels'],
  vocabulary: ['vocabulary'],
  core: ['agents', 'tools', 'configs', 'behavior_profiles'],
  prompts: [],
} as const satisfies Record<LayerName, readonly (keyof LockFileV2)[]>;

function hasAuthoritativeLayerMetadata(manifestV2: ProjectManifestV2 | null): boolean {
  const entityCounts = manifestV2?.metadata?.entity_counts;
  return Boolean(
    entityCounts && CANONICAL_LAYER_NAMES.some((layer) => entityCounts[layer] !== undefined),
  );
}

function validateManifestLayerParity(input: {
  manifestV2: ProjectManifestV2 | null;
  lockfileV2: LockFileV2 | null;
  layerFiles: Record<LayerName, Map<string, string>>;
  errors: string[];
}): void {
  const { manifestV2, lockfileV2, layerFiles, errors } = input;
  if (!manifestV2 || !hasAuthoritativeLayerMetadata(manifestV2)) {
    return;
  }

  const declaredRaw = manifestV2.layers_included ?? [];
  const declaredLayers = new Set<LayerName>();
  for (const layer of declaredRaw) {
    if (!LAYER_NAME_SET.has(String(layer))) {
      errors.push(`project.json: Unknown layer "${String(layer)}" in layers_included`);
      continue;
    }
    declaredLayers.add(layer as LayerName);
  }

  for (const layer of CANONICAL_LAYER_NAMES) {
    const fileCount = layerFiles[layer].size;
    const manifestCount = Number(manifestV2.metadata.entity_counts[layer] ?? 0);
    const isDeclared = declaredLayers.has(layer);

    if (isDeclared && manifestCount > 0 && fileCount === 0) {
      errors.push(
        `project.json: Layer "${layer}" is declared in layers_included with entity_counts.${layer}=${manifestCount} but no matching archive files were found`,
      );
    }

    if (!isDeclared && fileCount > 0) {
      errors.push(
        `project.json: Layer "${layer}" has archive files but is missing from layers_included`,
      );
    }
  }

  validateDuplicateLogicalNames(layerFiles, errors);
  validateLockfileLayerParity(manifestV2, lockfileV2, layerFiles, declaredLayers, errors);
}

function validateDuplicateLogicalNames(
  layerFiles: Record<LayerName, Map<string, string>>,
  errors: string[],
): void {
  for (const layer of CANONICAL_LAYER_NAMES) {
    const names = new Map<string, string>();
    for (const [path, content] of layerFiles[layer]) {
      const name = extractLogicalEntityName(layer, path, content);
      if (!name) {
        continue;
      }
      const existing = names.get(name);
      if (existing) {
        errors.push(
          `Layer "${layer}" contains duplicate entity name "${name}" in ${existing} and ${path}`,
        );
        continue;
      }
      names.set(name, path);
    }
  }
}

function validateLockfileLayerParity(
  manifestV2: ProjectManifestV2,
  lockfileV2: LockFileV2 | null,
  layerFiles: Record<LayerName, Map<string, string>>,
  declaredLayers: Set<LayerName>,
  errors: string[],
): void {
  if (!lockfileV2?.layer_hashes) {
    return;
  }

  const layerHashes = lockfileV2.layer_hashes as Partial<Record<LayerName, string>>;
  for (const layer of CANONICAL_LAYER_NAMES) {
    const manifestCount = Number(manifestV2.metadata.entity_counts[layer] ?? 0);
    const fileCount = layerFiles[layer].size;
    const hasLayerHash = Boolean(layerHashes[layer]);

    if (declaredLayers.has(layer) && (manifestCount > 0 || fileCount > 0) && !hasLayerHash) {
      errors.push(`abl.lock: Missing layer_hashes.${layer} for manifest-declared layer "${layer}"`);
    }

    if (!declaredLayers.has(layer) && hasLayerHash) {
      errors.push(
        `abl.lock: layer_hashes.${layer} exists but layer "${layer}" is missing from layers_included`,
      );
    }

    if (
      declaredLayers.has(layer) &&
      manifestCount > 0 &&
      hasLayerHash &&
      !lockfileHasEntriesForLayer(lockfileV2, layer)
    ) {
      errors.push(
        `abl.lock: Layer "${layer}" has entity_counts.${layer}=${manifestCount} but no corresponding lockfile entries`,
      );
    }
  }
}

function lockfileHasEntriesForLayer(lockfileV2: LockFileV2, layer: LayerName): boolean {
  const sections = LOCKFILE_LAYER_SECTIONS[layer];
  if (sections.length === 0) {
    return true;
  }

  return sections.some((section) => {
    const value = lockfileV2[section];
    return Boolean(
      value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0,
    );
  });
}

function extractLogicalEntityName(layer: LayerName, path: string, content: string): string | null {
  if (layer === 'core') {
    if (path.startsWith('agents/')) {
      return extractAgentName(content);
    }
    if (path.startsWith('tools/')) {
      return path.replace(/^tools\//, '').replace(/\.tools\.abl$/, '');
    }
    if (path.startsWith('behavior_profiles/')) {
      return (
        extractBehaviorProfileNameFromDsl(content) ??
        path
          .replace(/^behavior_profiles\//, '')
          .replace(/\.behavior_profile\.abl$/, '')
          .replace(/\.profile\.abl$/, '')
          .replace(/\.abl$/, '')
      );
    }
    return null;
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const value = parsed.name ?? parsed.displayName ?? parsed.slug ?? parsed.connectorName;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect which layers are present in a v2 folder read result.
 * A layer is present if it has at least one file.
 *
 * @param result - The result from readFolderV2
 * @returns Array of detected layer names
 */
export function detectLayers(result: FolderReadResultV2): LayerName[] {
  const layers: LayerName[] = [];

  for (const [layerName, files] of Object.entries(result.layerFiles)) {
    if (files.size > 0) {
      layers.push(layerName as LayerName);
    }
  }

  return layers;
}
