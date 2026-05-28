/**
 * Local ABL lockfile repair commands.
 *
 * These commands operate on an exported project folder and do not call Studio.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

type LayerName =
  | 'core'
  | 'connections'
  | 'prompts'
  | 'guardrails'
  | 'workflows'
  | 'evals'
  | 'search'
  | 'channels'
  | 'vocabulary';

interface SourceHashRecord {
  source_hash: string;
  [key: string]: unknown;
}

interface AgentHashRecord extends SourceHashRecord {
  version: string;
  status: string;
}

interface LockFileV2 {
  lockfile_version: '2.0';
  generated_at: string;
  agents: Record<string, AgentHashRecord>;
  tools: Record<string, SourceHashRecord>;
  configs: Record<string, SourceHashRecord>;
  connections: Record<string, SourceHashRecord>;
  guardrails: Record<string, SourceHashRecord>;
  workflows: Record<string, SourceHashRecord>;
  evals: Record<string, SourceHashRecord>;
  search: Record<string, SourceHashRecord>;
  channels: Record<string, SourceHashRecord>;
  vocabulary: Record<string, SourceHashRecord>;
  layer_hashes: Partial<Record<LayerName, string>>;
  integrity: string;
}

interface ProjectManifestAgent {
  path?: string;
  systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
}

interface ProjectManifest {
  agents?: Record<string, ProjectManifestAgent>;
  layers_included?: LayerName[];
}

interface AgentPromptLibraryRefSnapshot {
  promptId: string;
  versionId: string;
  resolvedHash?: string;
}

interface RecomputeOptions {
  check?: boolean;
}

export interface LockfileRecomputeResult {
  changed: boolean;
  lockfilePath: string;
  sourceHashesUpdated: number;
  layerHashesUpdated: number;
  warnings: string[];
}

const LOCKFILE_NAME = 'abl.lock';
const PROJECT_MANIFEST_NAME = 'project.json';
const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'dist', 'build', 'node_modules']);
const HASH_SECTIONS = [
  'tools',
  'configs',
  'connections',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
] as const;

export function registerLockfileCommands(program: Command): void {
  const lockfile = program
    .command('lockfile')
    .description('Inspect and repair local ABL lockfiles');

  lockfile
    .command('recompute <projectDir>')
    .description('Recompute source hashes, layer hashes, and integrity for a local abl.lock')
    .option('--check', 'Validate whether abl.lock is already up to date without writing', false)
    .action(async (projectDir: string, opts: RecomputeOptions) => {
      try {
        const result = await recomputeAblLockfile(projectDir, { check: opts.check });
        if (opts.check) {
          if (result.changed) {
            printErr(chalk.red(`abl.lock is stale: ${result.lockfilePath}`));
            process.exitCode = 1;
            return;
          }
          print(chalk.green(`abl.lock is up to date: ${result.lockfilePath}`));
          return;
        }

        const status = result.changed ? 'Recomputed' : 'No changes needed for';
        print(chalk.green(`${status} ${result.lockfilePath}`));
        print(
          chalk.gray(
            `  source hashes: ${result.sourceHashesUpdated}, layer hashes: ${result.layerHashesUpdated}`,
          ),
        );
        for (const warning of result.warnings) {
          print(chalk.yellow(`  warning: ${warning}`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        printErr(chalk.red(`Lockfile recompute failed: ${message}`));
        process.exitCode = 1;
      }
    });
}

export async function recomputeAblLockfile(
  projectDir: string,
  options: RecomputeOptions = {},
): Promise<LockfileRecomputeResult> {
  const root = resolve(projectDir);
  const lockfilePath = join(root, LOCKFILE_NAME);
  const originalLockfileContent = await readFile(lockfilePath, 'utf8');
  const lockfile = parseLockfileV2(originalLockfileContent);
  const files = await readProjectFiles(root);
  const manifest = parseProjectManifest(files.get(PROJECT_MANIFEST_NAME));
  const warnings: string[] = [];
  let sourceHashesUpdated = 0;

  for (const [agentName, record] of Object.entries(lockfile.agents)) {
    const sourcePath = findAgentSourcePath(agentName, manifest, files);
    if (!sourcePath) {
      throw new Error(`Cannot find source file for agent "${agentName}"`);
    }
    const source = files.get(sourcePath);
    if (source === undefined) {
      throw new Error(`Cannot read source file for agent "${agentName}" at ${sourcePath}`);
    }
    record.source_hash = computeAgentSourceHash(
      source,
      normalizePromptLibraryRefSnapshot(manifest?.agents?.[agentName]?.systemPromptLibraryRef),
    );
    sourceHashesUpdated++;
  }

  for (const section of HASH_SECTIONS) {
    const records = lockfile[section];
    for (const [filePath, record] of Object.entries(records)) {
      const source = files.get(filePath);
      if (source === undefined) {
        throw new Error(`Cannot find source file for ${section} entry "${filePath}"`);
      }
      record.source_hash = computeSourceHash(source);
      sourceHashesUpdated++;
    }
  }

  lockfile.layer_hashes = computeLayerHashes(files, manifest);
  lockfile.integrity = computeLockfileV2Integrity(lockfile);

  const nextLockfileContent = JSON.stringify(lockfile, null, 2) + '\n';
  const changed = nextLockfileContent !== originalLockfileContent;
  if (!options.check && changed) {
    await writeFile(lockfilePath, nextLockfileContent, 'utf8');
  }

  if (!files.has(PROJECT_MANIFEST_NAME)) {
    warnings.push('project.json was not found; agent files were resolved by filename only');
  }

  return {
    changed,
    lockfilePath,
    sourceHashesUpdated,
    layerHashesUpdated: Object.keys(lockfile.layer_hashes).length,
    warnings,
  };
}

function parseLockfileV2(content: string): LockFileV2 {
  const parsed = JSON.parse(content) as Partial<LockFileV2>;
  if (parsed.lockfile_version !== '2.0') {
    throw new Error('Only abl.lock version 2.0 is supported by local recompute');
  }

  return {
    lockfile_version: '2.0',
    generated_at: requireString(parsed.generated_at, 'generated_at'),
    agents: requireRecord(parsed.agents, 'agents') as Record<string, AgentHashRecord>,
    tools: requireRecord(parsed.tools, 'tools') as Record<string, SourceHashRecord>,
    configs: requireRecord(parsed.configs, 'configs') as Record<string, SourceHashRecord>,
    connections: requireRecord(parsed.connections, 'connections') as Record<
      string,
      SourceHashRecord
    >,
    guardrails: requireRecord(parsed.guardrails, 'guardrails') as Record<string, SourceHashRecord>,
    workflows: requireRecord(parsed.workflows, 'workflows') as Record<string, SourceHashRecord>,
    evals: requireRecord(parsed.evals, 'evals') as Record<string, SourceHashRecord>,
    search: requireRecord(parsed.search, 'search') as Record<string, SourceHashRecord>,
    channels: requireRecord(parsed.channels, 'channels') as Record<string, SourceHashRecord>,
    vocabulary: requireRecord(parsed.vocabulary, 'vocabulary') as Record<string, SourceHashRecord>,
    layer_hashes: requireRecord(parsed.layer_hashes, 'layer_hashes') as Partial<
      Record<LayerName, string>
    >,
    integrity: typeof parsed.integrity === 'string' ? parsed.integrity : '',
  };
}

async function readProjectFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await readDirectory(root, '', files);
  return files;
}

async function readDirectory(
  absoluteDir: string,
  relativeDir: string,
  files: Map<string, string>,
): Promise<void> {
  const entries = await readdir(absoluteDir);
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue;
    }

    const absolutePath = join(absoluteDir, entry);
    const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
    const fileStat = await lstat(absolutePath);
    if (fileStat.isDirectory()) {
      await readDirectory(absolutePath, relativePath, files);
      continue;
    }
    if (!fileStat.isFile()) {
      continue;
    }
    files.set(relativePath, await readFile(absolutePath, 'utf8'));
  }
}

function parseProjectManifest(content: string | undefined): ProjectManifest | undefined {
  if (!content) {
    return undefined;
  }
  const parsed = JSON.parse(content) as ProjectManifest;
  return parsed;
}

function findAgentSourcePath(
  agentName: string,
  manifest: ProjectManifest | undefined,
  files: Map<string, string>,
): string | undefined {
  const manifestPath = manifest?.agents?.[agentName]?.path;
  if (manifestPath && files.has(manifestPath)) {
    return manifestPath;
  }

  const candidates = [
    agentName,
    `agents/${agentName}.agent.abl`,
    `agents/${agentName}.abl`,
    `agents/${slugify(agentName)}.agent.abl`,
    `agents/${slugify(agentName)}.abl`,
  ];
  for (const candidate of candidates) {
    if (files.has(candidate)) {
      return candidate;
    }
  }

  const normalizedAgentName = normalizeAgentFilename(agentName);
  return [...files.keys()].find(
    (filePath) =>
      filePath.startsWith('agents/') &&
      normalizeAgentFilename(basename(filePath).replace(/\.agent\.abl$|\.abl$/u, '')) ===
        normalizedAgentName,
  );
}

function computeLayerHashes(
  files: Map<string, string>,
  manifest: ProjectManifest | undefined,
): Partial<Record<LayerName, string>> {
  const layers = new Map<LayerName, Map<string, string>>();
  for (const layer of manifest?.layers_included ?? []) {
    layers.set(layer, new Map());
  }

  for (const [filePath, content] of files) {
    if (filePath === LOCKFILE_NAME || filePath === PROJECT_MANIFEST_NAME) {
      continue;
    }
    const layer = detectLayer(filePath);
    let layerFiles = layers.get(layer);
    if (!layerFiles) {
      layerFiles = new Map<string, string>();
      layers.set(layer, layerFiles);
    }
    layerFiles.set(filePath, content);
  }

  const hashes: Partial<Record<LayerName, string>> = {};
  for (const [layer, layerFiles] of layers) {
    hashes[layer] = computeLayerHash(layerFiles);
  }
  return hashes;
}

function detectLayer(filePath: string): LayerName {
  if (filePath.startsWith('connections/')) return 'connections';
  if (filePath.startsWith('prompts/')) return 'prompts';
  if (filePath.startsWith('guardrails/')) return 'guardrails';
  if (filePath.startsWith('workflows/')) return 'workflows';
  if (filePath.startsWith('evals/')) return 'evals';
  if (filePath.startsWith('search/')) return 'search';
  if (filePath.startsWith('channels/')) return 'channels';
  if (filePath.startsWith('vocabulary/')) return 'vocabulary';
  return 'core';
}

function computeAgentSourceHash(
  dslContent: string,
  systemPromptLibraryRef: AgentPromptLibraryRefSnapshot | null,
): string {
  return computeSourceHash(
    buildProjectAgentDraftHashContent({
      dslContent,
      systemPromptLibraryRef,
    }),
  );
}

function buildProjectAgentDraftHashContent(input: {
  dslContent: string;
  systemPromptLibraryRef: AgentPromptLibraryRefSnapshot | null;
}): string {
  const companionHashInput = buildAgentCompanionHashInput({
    systemPromptLibraryRef: input.systemPromptLibraryRef,
  });
  if (!companionHashInput) {
    return input.dslContent;
  }

  return stableStringifyHashPayload({
    dslContent: input.dslContent,
    companion: companionHashInput,
  });
}

function normalizePromptLibraryRefSnapshot(ref: unknown): AgentPromptLibraryRefSnapshot | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const promptId = 'promptId' in ref ? ref.promptId : undefined;
  const versionId = 'versionId' in ref ? ref.versionId : undefined;
  const resolvedHash = 'resolvedHash' in ref ? ref.resolvedHash : undefined;

  if (typeof promptId !== 'string' || typeof versionId !== 'string') {
    return null;
  }

  return {
    promptId,
    versionId,
    ...(typeof resolvedHash === 'string' ? { resolvedHash } : {}),
  };
}

function buildAgentCompanionHashInput(value: {
  systemPromptLibraryRef: AgentPromptLibraryRefSnapshot | null;
}): Record<string, unknown> | null {
  if (!value.systemPromptLibraryRef) {
    return null;
  }

  return {
    systemPromptLibraryRef: value.systemPromptLibraryRef,
    resolvedSystemPrompt: null,
  };
}

function stableStringifyHashPayload(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, currentValue) =>
    currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
      ? Object.fromEntries(Object.entries(currentValue as Record<string, unknown>).sort())
      : currentValue,
  );
}

function computeSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function computeLayerHash(files: Map<string, string>): string {
  const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const content = sorted.map(([path, data]) => `${path}:${computeSourceHash(data)}`).join('\n');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function computeLockfileV2Integrity(lockfile: LockFileV2): string {
  const integrityPayload = JSON.stringify({
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
  return createHash('sha256').update(integrityPayload, 'utf8').digest('hex');
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`abl.lock is missing object field "${field}"`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`abl.lock is missing string field "${field}"`);
  }
  return value;
}

function slugify(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function normalizeAgentFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printErr(message: string): void {
  process.stderr.write(`${message}\n`);
}
