/**
 * Deployment Module Build Service
 *
 * Resolves module dependencies at deploy time, rewrites IR with alias prefixes,
 * creates compressed deployment snapshots.
 *
 * LLD Sections 5.1, 5.2, 5.3
 */

import { compileABLtoIR, resolveConfigVariables, type AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { ToolDefinitionLocal } from '@agent-platform/shared/tools';
import {
  attachAgentCompanionLibraryRefs,
  normalizeAgentCompanionMetadata,
  type AgentCompanionMetadata,
} from '@agent-platform/project-io';

import type {
  DeploymentModuleDependency,
  DeploymentModuleSnapshotPayload,
  MountedAgentEntry,
  MountedToolEntry,
} from './types.js';
import {
  validateAuthProfileChecks,
  validateContractAuthProfiles,
  type ContractAuthProfileCheck,
  type ContractAuthProfileIssue,
} from './contract-auth-validator.js';
import {
  coerceToolRuntimeNumericFields,
  resolveConfigTemplatesInValue,
  resolveRuntimeConfigKeysInAgentIR,
} from '../tool-runtime-config-resolution.js';

const log = createLogger('deployment-build-service');
const gzip = promisify(zlib.gzip);

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum uncompressed snapshot size (8 MB) */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Maximum mounted symbols (agents + tools) */
const MAX_MOUNTED_SYMBOLS = 250;

/** Maximum build diagnostics returned */
const MAX_DIAGNOSTICS = 10;

/** Redis lock key prefix */
const LOCK_KEY_PREFIX = 'module:deploy';

/** Lock TTL in milliseconds (60s) */
const LOCK_TTL_MS = 60_000;

// ─── Distributed Lock ────────────────────────────────────────────────────────

/**
 * Acquire a Redis distributed lock for module deployment builds.
 * Uses SET NX PX for atomic acquire.
 * Returns the lock value (for safe release) or null if lock not acquired.
 */
async function acquireDeployLock(
  redis: { set: Function; eval: Function },
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  const lockKey = `${LOCK_KEY_PREFIX}:${tenantId}:${projectId}`;
  const lockValue = crypto.randomUUID();

  const result = await redis.set(lockKey, lockValue, 'NX', 'PX', LOCK_TTL_MS);
  if (result === 'OK') {
    return lockValue;
  }
  return null;
}

/**
 * Release a Redis distributed lock using atomic compare-and-delete (Lua script).
 */
async function releaseDeployLock(
  redis: { eval: Function },
  tenantId: string,
  projectId: string,
  lockValue: string,
): Promise<void> {
  const lockKey = `${LOCK_KEY_PREFIX}:${tenantId}:${projectId}`;
  const releaseLockScript: LuaScript = {
    name: 'deploy-lock-release',
    body: `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `,
    numberOfKeys: 1,
  };
  try {
    await runLuaScript(redis as unknown as RedisClient, releaseLockScript, [lockKey], [lockValue]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to release deploy lock', { lockKey, error: message });
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModuleBuildDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  source: string;
  message: string;
}

export interface ModuleBuildResult {
  success: boolean;
  snapshotId?: string;
  snapshotHash?: string;
  mountedAgentCount: number;
  mountedToolCount: number;
  diagnostics: ModuleBuildDiagnostic[];
}

interface ResolvedModuleDependencyBuildTarget {
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  resolvedVersion: string;
  configOverrides: Record<string, string>;
  releaseDoc: Record<string, unknown>;
}

interface ModuleArtifactToolEntry {
  dslContent: string;
  toolType: string;
  sourceHash: string;
  definition?: Record<string, unknown>;
}

interface ModuleArtifactAgentEntry {
  dslContent: string;
  sourceHash: string;
  companion?: AgentCompanionMetadata;
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

const DEPLOYMENT_RUNTIME_TOOL_KEYS = [
  'auth_profile_ref',
  'workflow_binding',
  'searchai_binding',
  'http_binding',
  'mcp_binding',
  'sandbox_binding',
  'connector_binding',
  'async_webhook_binding',
] as const;

function resolveAgentRuntimeConfigRefsForDeployment(
  ir: AgentIR,
  configVars: Record<string, string>,
  context: string,
): { ir: AgentIR; errors: string[] } {
  const cloned = cloneJson(ir) as AgentIR & { tools?: Array<Record<string, unknown>> };
  const errors: string[] = [];

  if (!Array.isArray(cloned.tools)) {
    cloned.tools = [];
  }

  for (const tool of cloned.tools) {
    const mutableTool = tool as Record<string, unknown>;
    for (const key of DEPLOYMENT_RUNTIME_TOOL_KEYS) {
      if (!(key in mutableTool)) {
        continue;
      }

      const resolved = resolveConfigTemplatesInValue(mutableTool[key], configVars, context);
      mutableTool[key] = resolved.value;
      errors.push(...resolved.errors);
    }

    coerceToolRuntimeNumericFields(mutableTool, context, errors);
  }

  return { ir: cloned as AgentIR, errors };
}

function getReleaseRuntimeConfigForAgent(params: {
  artifactAgentName: string;
  parsedAgentName: string;
  releaseCompiledIR?: Record<string, unknown>;
}): AgentIR['project_runtime_config'] | undefined {
  const compiledIR =
    params.releaseCompiledIR?.[params.artifactAgentName] ??
    params.releaseCompiledIR?.[params.parsedAgentName];
  if (!compiledIR || typeof compiledIR !== 'object') {
    return undefined;
  }

  const runtimeConfig = (
    compiledIR as { project_runtime_config?: AgentIR['project_runtime_config'] }
  ).project_runtime_config;
  return runtimeConfig === undefined ? undefined : cloneJson(runtimeConfig);
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }

  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortForStableStringify((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

function formatArtifactCompilationError(error: {
  agent?: string;
  code?: string;
  path?: string;
  message: string;
}): string {
  const parts = [
    error.agent ? `${error.agent}` : null,
    error.code ? `[${error.code}]` : null,
    error.path ? `${error.path}` : null,
    error.message,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);

  return parts.join(' ');
}

type ArtifactRecompileResult =
  | {
      kind: 'success';
      agentIRs: Record<string, AgentIR>;
      toolDefs: Record<string, { definition: ToolDefinitionLocal; toolType: string }>;
      diagnostics: ModuleBuildDiagnostic[];
    }
  | { kind: 'legacy_fallback' }
  | { kind: 'failure'; diagnostics: ModuleBuildDiagnostic[] };

function canRecompileArtifactAgents(
  artifactAgents: Record<string, ModuleArtifactAgentEntry>,
): boolean {
  for (const agent of Object.values(artifactAgents)) {
    const companion = normalizeAgentCompanionMetadata(agent.companion);
    if (companion?.systemPromptLibraryRef && !companion.resolvedSystemPrompt) {
      return false;
    }
  }

  return true;
}

function parseArtifactDocument(dslContent: string, context: string): AgentBasedDocument | null {
  const parseResult = parseAgentBasedABL(dslContent);
  if (!parseResult.document || parseResult.errors.length > 0) {
    log.debug('Artifact source could not be reparsed for deploy-time recompilation', {
      source: context,
      errors: parseResult.errors.map((entry) => entry.message),
    });
    return null;
  }

  return parseResult.document;
}

function buildArtifactToolDefinitionsByAgent(
  documents: AgentBasedDocument[],
  artifactTools: Record<string, ModuleArtifactToolEntry> | undefined,
  mergedConfigVars: Record<string, string>,
  alias: string,
  moduleReleaseId: string,
  materializeModuleToolDefinition: (
    dslContent: string,
    toolType: string,
  ) => Record<string, unknown>,
):
  | {
      success: true;
      toolDefs: Record<string, { definition: ToolDefinitionLocal; toolType: string }>;
      resolvedToolImplementations: Map<string, import('@abl/compiler').ToolDefinition[]>;
      diagnostics: ModuleBuildDiagnostic[];
    }
  | {
      success: false;
      diagnostics: ModuleBuildDiagnostic[];
    } {
  const diagnostics: ModuleBuildDiagnostic[] = [];
  const toolDefs: Record<string, { definition: ToolDefinitionLocal; toolType: string }> = {};
  const resolvedToolImplementations = new Map<string, import('@abl/compiler').ToolDefinition[]>();
  const safeArtifactTools = artifactTools ?? {};

  function resolveArtifactToolDefinition(
    toolName: string,
    toolData: ModuleArtifactToolEntry,
  ): { definition: ToolDefinitionLocal; toolType: string } {
    const baseDefinition =
      toolData.definition ??
      (materializeModuleToolDefinition(toolData.dslContent, toolData.toolType) as Record<
        string,
        unknown
      >);

    const resolvedDefinition = resolveConfigTemplatesInValue(
      baseDefinition,
      mergedConfigVars,
      `dependency "${alias}" tool "${toolName}"`,
    );
    const definition = resolvedDefinition.value as Record<string, unknown>;
    coerceToolRuntimeNumericFields(
      definition,
      `dependency "${alias}" tool "${toolName}"`,
      resolvedDefinition.errors,
    );
    for (const error of resolvedDefinition.errors) {
      diagnostics.push({
        severity: 'error',
        code: 'UNRESOLVED_CONFIG_VARIABLE',
        source: `dependency:${alias}:tool:${toolName}`,
        message: error,
      });
    }

    return {
      definition: definition as unknown as ToolDefinitionLocal,
      toolType: toolData.toolType || 'unknown',
    };
  }

  for (const document of documents) {
    const declaredToolNames = (document.tools ?? [])
      .map((tool) => tool.name)
      .filter(
        (toolName): toolName is string => typeof toolName === 'string' && toolName.length > 0,
      );

    if (declaredToolNames.length === 0) {
      continue;
    }

    const resolvedDefinitions: import('@abl/compiler').ToolDefinition[] = [];
    for (const toolName of declaredToolNames) {
      const toolData = safeArtifactTools[toolName];
      if (!toolData) {
        diagnostics.push({
          severity: 'error',
          code: 'ARTIFACT_RECOMPILE_FAILED',
          source: `dependency:${alias}:tool:${toolName}`,
          message: `Artifact tool "${toolName}" required for release ${moduleReleaseId} is missing from the release package.`,
        });
        continue;
      }

      const resolvedTool = resolveArtifactToolDefinition(toolName, toolData);
      toolDefs[toolName] = resolvedTool;
      resolvedDefinitions.push(
        resolvedTool.definition as unknown as import('@abl/compiler').ToolDefinition,
      );
    }

    if (resolvedDefinitions.length > 0) {
      resolvedToolImplementations.set(document.name, resolvedDefinitions);
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { success: false, diagnostics };
  }

  for (const [toolName, toolData] of Object.entries(safeArtifactTools)) {
    if (toolDefs[toolName]) {
      continue;
    }

    toolDefs[toolName] = resolveArtifactToolDefinition(toolName, toolData);
  }

  return {
    success: true,
    toolDefs,
    resolvedToolImplementations,
    diagnostics,
  };
}

function recompileArtifactRelease(params: {
  alias: string;
  artifact: {
    agents: Record<string, ModuleArtifactAgentEntry>;
    profiles?: Record<string, { dslContent: string; sourceHash: string }>;
    tools: Record<string, ModuleArtifactToolEntry>;
  };
  mergedConfigVars: Record<string, string>;
  moduleReleaseId: string;
  releaseCompiledIR?: Record<string, unknown>;
  materializeModuleToolDefinition: (
    dslContent: string,
    toolType: string,
  ) => Record<string, unknown>;
}): ArtifactRecompileResult {
  if (!canRecompileArtifactAgents(params.artifact.agents)) {
    return { kind: 'legacy_fallback' };
  }

  const documents: AgentBasedDocument[] = [];
  const diagnostics: ModuleBuildDiagnostic[] = [];
  const parsedNameByArtifactName = new Map<string, string>();
  const companionByArtifactName: Record<string, AgentCompanionMetadata | null> = {};

  for (const [artifactAgentName, agentEntry] of Object.entries(params.artifact.agents)) {
    const parsedDocument = parseArtifactDocument(
      agentEntry.dslContent,
      `dependency:${params.alias}:agent:${artifactAgentName}`,
    );
    if (!parsedDocument) {
      return { kind: 'legacy_fallback' };
    }

    const companion = normalizeAgentCompanionMetadata(agentEntry.companion);
    const documentWithCompanion = parsedDocument as AgentBasedDocument & {
      systemPrompt?: string | null;
      systemPromptLibraryRef?: AgentCompanionMetadata['systemPromptLibraryRef'];
    };
    if (companion?.resolvedSystemPrompt) {
      documentWithCompanion.systemPrompt = companion.resolvedSystemPrompt;
    }
    if (companion?.systemPromptLibraryRef) {
      documentWithCompanion.systemPromptLibraryRef = { ...companion.systemPromptLibraryRef };
    }

    companionByArtifactName[artifactAgentName] = companion;
    parsedNameByArtifactName.set(artifactAgentName, parsedDocument.name);
    documents.push(parsedDocument);
  }

  for (const [profileName, profileEntry] of Object.entries(params.artifact.profiles ?? {})) {
    const parsedDocument = parseArtifactDocument(
      profileEntry.dslContent,
      `dependency:${params.alias}:profile:${profileName}`,
    );
    if (!parsedDocument) {
      return { kind: 'legacy_fallback' };
    }

    documents.push(parsedDocument);
  }

  const toolResolution = buildArtifactToolDefinitionsByAgent(
    documents.filter((document) => document.meta.kind === 'agent'),
    params.artifact.tools,
    params.mergedConfigVars,
    params.alias,
    params.moduleReleaseId,
    params.materializeModuleToolDefinition,
  );
  if (!toolResolution.success) {
    return { kind: 'failure', diagnostics: toolResolution.diagnostics };
  }
  diagnostics.push(...toolResolution.diagnostics);

  const compilerOptions: Record<string, unknown> = {};
  if (Object.keys(params.mergedConfigVars).length > 0) {
    compilerOptions.config_variables = params.mergedConfigVars;
  }
  if (toolResolution.resolvedToolImplementations.size > 0) {
    compilerOptions.resolvedToolImplementations = toolResolution.resolvedToolImplementations;
  }

  const compilationOutput = compileABLtoIR(
    documents,
    Object.keys(compilerOptions).length > 0 ? compilerOptions : undefined,
  );
  if ((compilationOutput.compilation_errors?.length ?? 0) > 0) {
    log.debug('Artifact sources failed deploy-time recompilation; falling back to compiled IR', {
      source: `dependency:${params.alias}`,
      errors: (compilationOutput.compilation_errors ?? []).map(formatArtifactCompilationError),
    });
    return { kind: 'legacy_fallback' };
  }

  const compiledAgentsByArtifactName: Record<string, AgentIR> = {};
  for (const [artifactAgentName, parsedAgentName] of parsedNameByArtifactName.entries()) {
    const compiledAgent = compilationOutput.agents?.[parsedAgentName];
    if (!compiledAgent) {
      log.debug('Artifact recompilation omitted an agent; falling back to compiled IR', {
        source: `dependency:${params.alias}:agent:${artifactAgentName}`,
        parsedAgentName,
      });
      return { kind: 'legacy_fallback' };
    }

    const runtimeKeyResult = resolveRuntimeConfigKeysInAgentIR(
      compiledAgent,
      params.mergedConfigVars,
      `dependency "${params.alias}" agent "${artifactAgentName}"`,
    );
    for (const error of runtimeKeyResult.errors) {
      diagnostics.push({
        severity: 'error',
        code: 'UNRESOLVED_CONFIG_VARIABLE',
        source: `dependency:${params.alias}:agent:${artifactAgentName}`,
        message: error,
      });
    }

    const deploymentRuntimeResult = resolveAgentRuntimeConfigRefsForDeployment(
      runtimeKeyResult.ir,
      params.mergedConfigVars,
      `dependency "${params.alias}" agent "${artifactAgentName}"`,
    );
    for (const error of deploymentRuntimeResult.errors) {
      diagnostics.push({
        severity: 'error',
        code: 'UNRESOLVED_CONFIG_VARIABLE',
        source: `dependency:${params.alias}:agent:${artifactAgentName}`,
        message: error,
      });
    }

    const releaseRuntimeConfig = getReleaseRuntimeConfigForAgent({
      artifactAgentName,
      parsedAgentName,
      releaseCompiledIR: params.releaseCompiledIR,
    });
    if (releaseRuntimeConfig !== undefined) {
      deploymentRuntimeResult.ir.project_runtime_config = releaseRuntimeConfig;
    }

    compiledAgentsByArtifactName[artifactAgentName] = deploymentRuntimeResult.ir;
  }

  attachAgentCompanionLibraryRefs(compiledAgentsByArtifactName, companionByArtifactName);

  return {
    kind: 'success',
    agentIRs: compiledAgentsByArtifactName,
    toolDefs: toolResolution.toolDefs,
    diagnostics,
  };
}

// ─── Main Service ────────────────────────────────────────────────────────────

/** Optional Redis client for distributed locking */
export interface RedisLockClient {
  set: (...args: unknown[]) => Promise<unknown>;
  eval: (...args: unknown[]) => Promise<unknown>;
}

export interface ModuleBuildOptions {
  redis?: RedisLockClient;
  environment?: string | null;
  userId?: string;
}

export interface CloneDeploymentModuleSnapshotOptions {
  sourceEnvironment?: string | null;
  targetEnvironment?: string | null;
}

interface SelectLeanQuery<T> {
  select: (fields: string) => { lean: () => Promise<T[]> };
}

interface PrerequisiteLookupModel<T> {
  find: (filter: Record<string, unknown>) => SelectLeanQuery<T>;
}

function isRedisLockClient(value: RedisLockClient | ModuleBuildOptions): value is RedisLockClient {
  return (
    typeof (value as RedisLockClient).set === 'function' &&
    typeof (value as RedisLockClient).eval === 'function'
  );
}

function normalizeModuleBuildOptions(
  options?: RedisLockClient | ModuleBuildOptions,
): ModuleBuildOptions {
  if (!options) {
    return {};
  }

  if (isRedisLockClient(options)) {
    return { redis: options };
  }

  return options;
}

function collectRequirementNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const names = new Set<string>();
  for (const entry of entries) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? (entry as Record<string, unknown>).name
          : null;
    if (typeof name === 'string' && name.trim().length > 0) {
      names.add(name.trim());
    }
  }

  return [...names];
}

function collectConfigKeyRequirements(entries: unknown): Array<{ key: string; isSecret: boolean }> {
  if (!Array.isArray(entries)) {
    return [];
  }

  const byKey = new Map<string, { key: string; isSecret: boolean }>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    if (!key) {
      continue;
    }

    byKey.set(key, { key, isSecret: record.isSecret === true });
  }

  return [...byKey.values()];
}

function collectSecretRequirements(entries: unknown): Array<{ key: string; toolName: string }> {
  if (!Array.isArray(entries)) {
    return [];
  }

  const byKey = new Map<string, { key: string; toolName: string }>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
    if (!key || !toolName) {
      continue;
    }

    byKey.set(`${toolName}:${key}`, { key, toolName });
  }

  return [...byKey.values()];
}

function hasNonEmptyConfigValue(config: Record<string, string>, key: string): boolean {
  const value = config[key];
  return (
    Object.prototype.hasOwnProperty.call(config, key) &&
    typeof value === 'string' &&
    value.trim().length > 0
  );
}

function filterConfigOverridesForContract(
  overrides: Record<string, string>,
  contract: unknown,
): Record<string, string> {
  const requiredConfigKeys = collectConfigKeyRequirements(
    (contract as Record<string, unknown> | null | undefined)?.requiredConfigKeys,
  );
  const declaredKeys = new Set(requiredConfigKeys.map((entry) => entry.key));
  if (declaredKeys.size === 0) {
    return {};
  }

  return Object.fromEntries(Object.entries(overrides).filter(([key]) => declaredKeys.has(key)));
}

function formatAuthProfileRemediation(issues: ContractAuthProfileIssue[]): string {
  return issues
    .map((issue) => {
      if (issue.status === 'type_mismatch') {
        return `Auth profile "${issue.profileName}" (required by dependency "${issue.referencedBy}") has type "${issue.actualType}" but expected "${issue.expectedType}"`;
      }
      if (issue.status === 'unresolved_template') {
        return `Auth profile reference "${issue.profileName}" (required by dependency "${issue.referencedBy}") still contains an unresolved template`;
      }
      const typeHint = issue.expectedType ? ` (expected type: ${issue.expectedType})` : '';
      return `Auth profile "${issue.profileName}" is missing${typeHint} — required by dependency "${issue.referencedBy}"`;
    })
    .join('; ');
}

function collectResolvedAuthProfileChecks(params: {
  alias: string;
  agentIRs: Record<string, AgentIR>;
  toolDefs: Record<string, { definition: ToolDefinitionLocal; toolType: string }>;
  userId?: string;
}): ContractAuthProfileCheck[] {
  type AuthProfileReferenceRecord = {
    auth_profile_ref?: unknown;
    connection_mode?: unknown;
  };
  const checks = new Map<string, ContractAuthProfileCheck>();

  const addCheck = (record: unknown, sourceName: string) => {
    if (record === null || typeof record !== 'object') {
      return;
    }

    const reference = record as AuthProfileReferenceRecord;
    const rawRef = reference.auth_profile_ref;
    if (typeof rawRef !== 'string' || rawRef.trim().length === 0) {
      return;
    }

    const connectionMode = reference.connection_mode;
    const lookupUserId = connectionMode === 'shared' ? undefined : params.userId;
    const name = rawRef.trim();
    const key = `${params.alias}:${sourceName}:${name}:${lookupUserId ?? 'tenant'}`;
    if (checks.has(key)) {
      return;
    }

    checks.set(key, {
      name,
      alias: params.alias,
      ...(lookupUserId ? { lookupUserId } : {}),
    });
  };

  for (const [agentName, ir] of Object.entries(params.agentIRs)) {
    const tools = (ir as AgentIR & { tools?: Array<Record<string, unknown>> }).tools;
    if (!Array.isArray(tools)) {
      continue;
    }

    for (const [index, tool] of tools.entries()) {
      const sourceName = typeof tool.name === 'string' ? tool.name : `${agentName}:tool:${index}`;
      addCheck(tool, sourceName);
    }
  }

  for (const [toolName, toolEntry] of Object.entries(params.toolDefs)) {
    addCheck(toolEntry.definition, `tool:${toolName}`);
  }

  return [...checks.values()];
}

function validateContractConfigKeyPrerequisites(params: {
  dependencies: ResolvedModuleDependencyBuildTarget[];
  projectConfigVars: Record<string, string>;
}): ModuleBuildDiagnostic[] {
  const diagnostics: ModuleBuildDiagnostic[] = [];

  for (const dependency of params.dependencies) {
    const contract = (dependency.releaseDoc.contract ?? {}) as Record<string, unknown>;
    const requiredConfigKeys = collectConfigKeyRequirements(contract.requiredConfigKeys);

    for (const requirement of requiredConfigKeys) {
      const hasProjectConfig = hasNonEmptyConfigValue(params.projectConfigVars, requirement.key);
      const hasOverride = hasNonEmptyConfigValue(dependency.configOverrides, requirement.key);
      const source = `dependency:${dependency.alias}:config:${requirement.key}`;

      if (requirement.isSecret && hasOverride) {
        diagnostics.push({
          severity: 'error',
          code: 'SECRET_CONFIG_OVERRIDE_REJECTED',
          source,
          message: `Deploy blocked: required secret config key "${requirement.key}" for dependency "${dependency.alias}" must be configured as a project config variable, not a dependency override.`,
        });
        continue;
      }

      if (requirement.isSecret) {
        continue;
      }

      if (!hasProjectConfig && !hasOverride) {
        diagnostics.push({
          severity: 'error',
          code: 'REQUIRED_CONFIG_KEY_MISSING',
          source,
          message: `Deploy blocked: required config key "${requirement.key}" for dependency "${dependency.alias}" is not configured in project config variables or dependency overrides.`,
        });
      }
    }
  }

  return diagnostics;
}

async function validateContractDeploymentPrerequisites(params: {
  tenantId: string;
  projectId: string;
  environment: string | null;
  dependencies: ResolvedModuleDependencyBuildTarget[];
  EnvironmentVariable: PrerequisiteLookupModel<Record<string, unknown>>;
  MCPServerConfig: PrerequisiteLookupModel<Record<string, unknown>>;
  ConnectorConnection: PrerequisiteLookupModel<Record<string, unknown>>;
  ToolSecret: PrerequisiteLookupModel<Record<string, unknown>>;
}): Promise<ModuleBuildDiagnostic[]> {
  if (!params.environment) {
    return [];
  }

  const requiredEnvByAlias = new Map<string, string[]>();
  const requiredMcpByAlias = new Map<string, string[]>();
  const requiredConnectorByAlias = new Map<string, string[]>();
  const requiredSecretByAlias = new Map<
    string,
    Array<{ key: string; sourceToolName: string; toolName: string }>
  >();
  const allEnvNames = new Set<string>();
  const allMcpNames = new Set<string>();
  const allConnectorNames = new Set<string>();
  const allSecretKeys = new Set<string>();
  const allSecretToolNames = new Set<string>();

  for (const dependency of params.dependencies) {
    const contract = (dependency.releaseDoc.contract ?? {}) as Record<string, unknown>;
    const legacySecretConfigKeys = new Set(
      collectConfigKeyRequirements(contract.requiredConfigKeys)
        .filter((entry) => entry.isSecret)
        .map((entry) => entry.key),
    );
    const envNames = collectRequirementNames(contract.requiredEnvVars).filter(
      (name) => !legacySecretConfigKeys.has(name),
    );
    const mcpNames = collectRequirementNames(contract.requiredMcpServers);
    const connectorNames = collectRequirementNames(contract.requiredConnectors);
    const secretRequirements = collectSecretRequirements(contract.requiredSecrets).map(
      (requirement) => ({
        key: requirement.key,
        sourceToolName: requirement.toolName,
        toolName: `${dependency.alias}__${requirement.toolName}`,
      }),
    );

    if (envNames.length > 0) {
      requiredEnvByAlias.set(dependency.alias, envNames);
      for (const name of envNames) {
        allEnvNames.add(name);
      }
    }
    if (mcpNames.length > 0) {
      requiredMcpByAlias.set(dependency.alias, mcpNames);
      for (const name of mcpNames) {
        allMcpNames.add(name);
      }
    }
    if (connectorNames.length > 0) {
      requiredConnectorByAlias.set(dependency.alias, connectorNames);
      for (const name of connectorNames) {
        allConnectorNames.add(name);
      }
    }
    if (secretRequirements.length > 0) {
      requiredSecretByAlias.set(dependency.alias, secretRequirements);
      for (const requirement of secretRequirements) {
        allSecretKeys.add(requirement.key);
        allSecretToolNames.add(requirement.toolName);
      }
    }
  }

  const presentEnvNames = new Set<string>();
  if (allEnvNames.size > 0) {
    const docs = await params.EnvironmentVariable.find({
      tenantId: params.tenantId,
      projectId: params.projectId,
      key: { $in: [...allEnvNames] },
      environment: { $in: [params.environment, 'global'] },
    })
      .select('key environment')
      .lean();

    for (const doc of docs as Array<Record<string, unknown>>) {
      if (typeof doc.key === 'string') {
        presentEnvNames.add(doc.key);
      }
    }
  }

  const presentMcpNames = new Set<string>();
  if (allMcpNames.size > 0) {
    const docs = await params.MCPServerConfig.find({
      tenantId: params.tenantId,
      projectId: params.projectId,
      name: { $in: [...allMcpNames] },
    })
      .select('name')
      .lean();

    for (const doc of docs as Array<Record<string, unknown>>) {
      if (typeof doc.name === 'string') {
        presentMcpNames.add(doc.name);
      }
    }
  }

  const presentConnectorNames = new Set<string>();
  if (allConnectorNames.size > 0) {
    const docs = await params.ConnectorConnection.find({
      tenantId: params.tenantId,
      projectId: params.projectId,
      connectorName: { $in: [...allConnectorNames] },
      status: 'active',
    })
      .select('connectorName')
      .lean();

    for (const doc of docs as Array<Record<string, unknown>>) {
      if (typeof doc.connectorName === 'string') {
        presentConnectorNames.add(doc.connectorName);
      }
    }
  }

  const presentSecretKeys = new Set<string>();
  if (allSecretKeys.size > 0) {
    const docs = await params.ToolSecret.find({
      tenantId: params.tenantId,
      projectId: params.projectId,
      secretKey: { $in: [...allSecretKeys] },
      toolName: { $in: [...allSecretToolNames] },
      environment: { $in: [params.environment, 'global'] },
    })
      .select('secretKey toolName environment expiresAt')
      .lean();

    const now = new Date();
    for (const doc of docs as Array<Record<string, unknown>>) {
      if (typeof doc.secretKey !== 'string' || typeof doc.toolName !== 'string') {
        continue;
      }
      const expiresAt = doc.expiresAt;
      if (expiresAt instanceof Date && expiresAt <= now) {
        continue;
      }
      presentSecretKeys.add(`${doc.toolName}:${doc.secretKey}`);
    }
  }

  const diagnostics: ModuleBuildDiagnostic[] = [];
  for (const dependency of params.dependencies) {
    for (const envName of requiredEnvByAlias.get(dependency.alias) ?? []) {
      if (presentEnvNames.has(envName)) {
        continue;
      }
      diagnostics.push({
        severity: 'error',
        code: 'REQUIRED_ENV_VAR_MISSING',
        source: `dependency:${dependency.alias}:env:${envName}`,
        message: `Deploy blocked: required environment variable "${envName}" for dependency "${dependency.alias}" is not configured for ${params.environment} or global scope.`,
      });
    }

    for (const mcpName of requiredMcpByAlias.get(dependency.alias) ?? []) {
      if (presentMcpNames.has(mcpName)) {
        continue;
      }
      diagnostics.push({
        severity: 'error',
        code: 'REQUIRED_MCP_SERVER_MISSING',
        source: `dependency:${dependency.alias}:mcp:${mcpName}`,
        message: `Deploy blocked: required MCP server "${mcpName}" for dependency "${dependency.alias}" is not configured in this project.`,
      });
    }

    for (const connectorName of requiredConnectorByAlias.get(dependency.alias) ?? []) {
      if (presentConnectorNames.has(connectorName)) {
        continue;
      }
      diagnostics.push({
        severity: 'error',
        code: 'REQUIRED_CONNECTOR_MISSING',
        source: `dependency:${dependency.alias}:connector:${connectorName}`,
        message: `Deploy blocked: required connector "${connectorName}" for dependency "${dependency.alias}" does not have an active project connection.`,
      });
    }

    for (const secret of requiredSecretByAlias.get(dependency.alias) ?? []) {
      if (presentSecretKeys.has(`${secret.toolName}:${secret.key}`)) {
        continue;
      }
      diagnostics.push({
        severity: 'error',
        code: 'REQUIRED_SECRET_MISSING',
        source: `dependency:${dependency.alias}:secret:${secret.toolName}:${secret.key}`,
        message: `Deploy blocked: required runtime secret "${secret.key}" for mounted tool "${secret.toolName}" (from dependency "${dependency.alias}" tool "${secret.sourceToolName}") is not configured for ${params.environment} or global scope.`,
      });
    }
  }

  return diagnostics;
}

/**
 * Build deployment module snapshot.
 *
 * Resolves all module dependencies for a project, rewrites IR with aliases,
 * creates a compressed snapshot, and stores it.
 *
 * @param redis - Optional Redis client for distributed lock. When provided,
 *   acquires `module:deploy:{tenantId}:{projectId}` lock per LLD Section 10.2.
 * @returns null if the project has no module dependencies (fast path)
 */
export async function buildDeploymentModuleSnapshot(
  tenantId: string,
  projectId: string,
  deploymentId: string,
  expectedDependencyVersion: number,
  existingSymbols: Set<string>,
  options?: RedisLockClient | ModuleBuildOptions,
): Promise<ModuleBuildResult | null> {
  const {
    ProjectModuleDependency,
    ModuleRelease,
    DeploymentModuleSnapshot,
    Project,
    EnvironmentVariable,
    MCPServerConfig,
    ConnectorConnection,
    ToolSecret,
  } = await import('@agent-platform/database/models');
  const buildOptions = normalizeModuleBuildOptions(options);
  const redis = buildOptions.redis;

  // ── Fast path: no module dependencies ──────────────────────────────
  const depCount = await ProjectModuleDependency.countDocuments({
    tenantId,
    projectId,
  });

  if (depCount === 0) {
    log.debug('No module dependencies — skipping module build', { projectId });
    return null;
  }

  // ── Acquire distributed lock (LLD Section 10.2) ────────────────────
  let lockValue: string | null = null;
  if (redis) {
    lockValue = await acquireDeployLock(redis, tenantId, projectId);
    if (!lockValue) {
      return {
        success: false,
        mountedAgentCount: 0,
        mountedToolCount: 0,
        diagnostics: [
          {
            severity: 'error',
            code: 'LOCK_ACQUISITION_FAILED',
            source: 'build',
            message:
              'Another module deployment build is in progress for this project. Retry after it completes.',
          },
        ],
      };
    }
  }

  try {
    return await _buildWithLock(
      tenantId,
      projectId,
      deploymentId,
      expectedDependencyVersion,
      existingSymbols,
      {
        ProjectModuleDependency,
        ModuleRelease,
        DeploymentModuleSnapshot,
        Project,
        EnvironmentVariable,
        MCPServerConfig,
        ConnectorConnection,
        ToolSecret,
      },
      buildOptions.environment ?? null,
      buildOptions.userId,
    );
  } finally {
    // Always release the lock
    if (redis && lockValue) {
      await releaseDeployLock(redis, tenantId, projectId, lockValue);
    }
  }
}

/** Inner build logic, executed while holding the distributed lock. */
async function _buildWithLock(
  tenantId: string,
  projectId: string,
  deploymentId: string,
  expectedDependencyVersion: number,
  existingSymbols: Set<string>,
  models: {
    ProjectModuleDependency: any;
    ModuleRelease: any;
    DeploymentModuleSnapshot: any;
    Project: any;
    EnvironmentVariable: PrerequisiteLookupModel<Record<string, unknown>>;
    MCPServerConfig: PrerequisiteLookupModel<Record<string, unknown>>;
    ConnectorConnection: PrerequisiteLookupModel<Record<string, unknown>>;
    ToolSecret: PrerequisiteLookupModel<Record<string, unknown>>;
  },
  environment: string | null,
  userId?: string,
): Promise<ModuleBuildResult> {
  const buildStartMs = Date.now();
  const {
    ProjectModuleDependency,
    ModuleRelease,
    DeploymentModuleSnapshot,
    Project,
    EnvironmentVariable,
    MCPServerConfig,
    ConnectorConnection,
    ToolSecret,
  } = models;

  // ── Pre-build: Verify dependency version hasn't changed ────────────
  const project = await Project.findOne({ _id: projectId, tenantId }).lean();
  if (!project) {
    return {
      success: false,
      mountedAgentCount: 0,
      mountedToolCount: 0,
      diagnostics: [
        {
          severity: 'error',
          code: 'PROJECT_NOT_FOUND',
          source: 'build',
          message: 'Project not found',
        },
      ],
    };
  }

  const currentDepVersion = (project as Record<string, unknown>).moduleDependencyVersion ?? 0;
  if (currentDepVersion !== expectedDependencyVersion) {
    return {
      success: false,
      mountedAgentCount: 0,
      mountedToolCount: 0,
      diagnostics: [
        {
          severity: 'error',
          code: 'DEPENDENCY_VERSION_MISMATCH',
          source: 'build',
          message: `Dependencies changed during build (expected v${expectedDependencyVersion}, current v${currentDepVersion}). Retry the deployment.`,
        },
      ],
    };
  }

  // ── Load dependencies ──────────────────────────────────────────────
  const dependencies = (await ProjectModuleDependency.find({
    tenantId,
    projectId,
  }).lean()) as Array<Record<string, unknown>>;

  const diagnostics: ModuleBuildDiagnostic[] = [];
  const mountedAgents: Record<string, MountedAgentEntry> = {};
  const mountedTools: Record<string, MountedToolEntry> = {};
  const allSymbols = new Set(existingSymbols);
  const resolvedDependencies: ResolvedModuleDependencyBuildTarget[] = [];

  const { rewriteModuleIR } = await import('./module-alias-rewriter.js');
  const { resolveSelector, materializeModuleToolDefinition } =
    await import('@agent-platform/project-io');
  const { loadConfigVariablesMap } = await import('../../repos/project-repo.js');

  let projectConfigVars: Record<string, string> = {};
  try {
    projectConfigVars = await loadConfigVariablesMap(projectId, tenantId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Failed to load project config variables for module deployment build', {
      tenantId,
      projectId,
      error: message,
    });
    diagnostics.push({
      severity: 'warning',
      code: 'CONFIG_LOAD_FAILED',
      source: 'build',
      message:
        'Project config variables could not be loaded during module deployment build; module config placeholders may remain unresolved.',
    });
  }

  for (const dep of dependencies) {
    const d = dep as Record<string, unknown>;
    const alias = d.alias as string;
    const moduleProjectId = d.moduleProjectId as string;
    const selector = d.selector as { type: 'version' | 'environment'; value: string };

    // ── Resolve release via selector ─────────────────────────────
    const selectorResult = await resolveSelector(tenantId, moduleProjectId, selector);

    if ('error' in selectorResult) {
      diagnostics.push({
        severity: 'error',
        code: 'SELECTOR_RESOLUTION_FAILED',
        source: `dependency:${alias}`,
        message: selectorResult.error,
      });
      continue;
    }

    const { releaseId, version } = selectorResult;

    // ── Load release artifact ────────────────────────────────────
    const release = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId,
      moduleProjectId,
      archivedAt: { $in: [null, undefined] },
    }).lean();

    if (!release) {
      diagnostics.push({
        severity: 'error',
        code: 'RELEASE_NOT_FOUND',
        source: `dependency:${alias}`,
        message: `Release ${releaseId} not found or archived for module ${moduleProjectId}`,
      });
      continue;
    }

    const releaseDoc = release as Record<string, unknown>;
    const rawConfigOverrides =
      typeof dep.configOverrides === 'object' && dep.configOverrides !== null
        ? (dep.configOverrides as Record<string, string>)
        : {};
    const configOverrides = filterConfigOverridesForContract(
      rawConfigOverrides,
      releaseDoc.contract,
    );
    resolvedDependencies.push({
      alias,
      moduleProjectId,
      moduleReleaseId: releaseId,
      resolvedVersion: (releaseDoc.version as string | undefined) ?? version,
      configOverrides,
      releaseDoc,
    });
  }

  const prerequisiteDiagnostics = await validateContractDeploymentPrerequisites({
    tenantId,
    projectId,
    environment,
    dependencies: resolvedDependencies,
    EnvironmentVariable,
    MCPServerConfig,
    ConnectorConnection,
    ToolSecret,
  });
  const configKeyDiagnostics = validateContractConfigKeyPrerequisites({
    dependencies: resolvedDependencies,
    projectConfigVars,
  });
  const blockingPrerequisiteDiagnostics = [...prerequisiteDiagnostics, ...configKeyDiagnostics];
  if (blockingPrerequisiteDiagnostics.length > 0) {
    return {
      success: false,
      mountedAgentCount: 0,
      mountedToolCount: 0,
      diagnostics: [...diagnostics, ...blockingPrerequisiteDiagnostics].slice(0, MAX_DIAGNOSTICS),
    };
  }

  // ── Auth profile preflight (LLD Task 2.6 — GAP-004 closure) ──────
  const authResult = await validateContractAuthProfiles(
    tenantId,
    projectId,
    resolvedDependencies.map((dep) => ({
      alias: dep.alias,
      contractSnapshot: (dep.releaseDoc.contract ??
        {}) as import('@agent-platform/database/models').ModuleReleaseContract,
    })),
    { environment, userId },
  );
  if (!authResult.success) {
    const remediation = formatAuthProfileRemediation(authResult.issues);

    return {
      success: false,
      mountedAgentCount: 0,
      mountedToolCount: 0,
      diagnostics: [
        ...diagnostics,
        {
          severity: 'error' as const,
          code: 'AUTH_PROFILE_PREFLIGHT_FAILED',
          source: 'auth-preflight',
          message: `Deploy blocked: ${remediation}. Create the required auth profiles before deploying.`,
        },
      ].slice(0, MAX_DIAGNOSTICS),
    };
  }

  for (const dep of resolvedDependencies) {
    const { alias, moduleProjectId, moduleReleaseId, releaseDoc, configOverrides } = dep;
    const artifact = releaseDoc.artifact as
      | {
          agents: Record<string, ModuleArtifactAgentEntry>;
          profiles?: Record<string, { dslContent: string; sourceHash: string }>;
          tools: Record<string, ModuleArtifactToolEntry>;
        }
      | undefined;

    if (!artifact) {
      diagnostics.push({
        severity: 'error',
        code: 'ARTIFACT_MISSING',
        source: `dependency:${alias}`,
        message: `Release ${moduleReleaseId} has no artifact`,
      });
      continue;
    }

    const compiledIR = releaseDoc.compiledIR as Record<string, unknown> | undefined;
    const mergedConfigVars = { ...projectConfigVars, ...configOverrides };

    let agentIRs: Record<string, AgentIR> = {};
    let toolDefs: Record<string, { definition: ToolDefinitionLocal; toolType: string }> = {};
    const recompilation = recompileArtifactRelease({
      alias,
      artifact,
      mergedConfigVars,
      moduleReleaseId,
      releaseCompiledIR: compiledIR,
      materializeModuleToolDefinition: (dslContent: string, toolType: string) =>
        materializeModuleToolDefinition(
          dslContent,
          toolType as Parameters<typeof materializeModuleToolDefinition>[1],
        ) as unknown as Record<string, unknown>,
    });

    if (recompilation.kind === 'failure') {
      diagnostics.push(...recompilation.diagnostics);
      continue;
    }

    if (recompilation.kind === 'success') {
      agentIRs = recompilation.agentIRs;
      toolDefs = recompilation.toolDefs;
      diagnostics.push(...recompilation.diagnostics);
    } else {
      // ── Extract legacy agent IR from compiledIR ─────────────────
      for (const agentName of Object.keys(artifact.agents || {})) {
        if (compiledIR?.[agentName]) {
          const resolvedIR = cloneJson(compiledIR[agentName]) as AgentIR & {
            tools?: Array<Record<string, unknown>>;
          };
          if (!Array.isArray(resolvedIR.tools)) {
            resolvedIR.tools = [];
          }

          const configResult = resolveConfigVariables(resolvedIR, mergedConfigVars);
          for (const error of configResult.errors) {
            diagnostics.push({
              severity: 'error',
              code: 'UNRESOLVED_CONFIG_VARIABLE',
              source: `dependency:${alias}:agent:${agentName}`,
              message: error,
            });
          }

          const runtimeKeyResult = resolveRuntimeConfigKeysInAgentIR(
            resolvedIR,
            mergedConfigVars,
            `dependency "${alias}" agent "${agentName}"`,
          );
          for (const error of runtimeKeyResult.errors) {
            diagnostics.push({
              severity: 'error',
              code: 'UNRESOLVED_CONFIG_VARIABLE',
              source: `dependency:${alias}:agent:${agentName}`,
              message: error,
            });
          }

          const deploymentRuntimeResult = resolveAgentRuntimeConfigRefsForDeployment(
            runtimeKeyResult.ir,
            mergedConfigVars,
            `dependency "${alias}" agent "${agentName}"`,
          );
          for (const error of deploymentRuntimeResult.errors) {
            diagnostics.push({
              severity: 'error',
              code: 'UNRESOLVED_CONFIG_VARIABLE',
              source: `dependency:${alias}:agent:${agentName}`,
              message: error,
            });
          }

          agentIRs[agentName] = deploymentRuntimeResult.ir;
        } else {
          diagnostics.push({
            severity: 'warning',
            code: 'MISSING_COMPILED_IR',
            source: `dependency:${alias}`,
            message: `Agent "${agentName}" has no compiled IR in release ${moduleReleaseId}`,
          });
        }
      }

      // ── Build tool definitions for rewriter ────────────────────
      for (const [toolName, toolData] of Object.entries(artifact.tools || {})) {
        const baseDefinition =
          toolData.definition ??
          (materializeModuleToolDefinition(
            toolData.dslContent,
            toolData.toolType as Parameters<typeof materializeModuleToolDefinition>[1],
          ) as unknown as Record<string, unknown>);

        if (!baseDefinition || typeof baseDefinition !== 'object') {
          diagnostics.push({
            severity: 'error',
            code: 'TOOL_DEFINITION_MISSING',
            source: `dependency:${alias}:tool:${toolName}`,
            message: `Tool "${toolName}" in release ${moduleReleaseId} could not be materialized for deployment.`,
          });
          continue;
        }

        const resolvedDefinition = resolveConfigTemplatesInValue(
          baseDefinition,
          mergedConfigVars,
          `dependency "${alias}" tool "${toolName}"`,
        );
        const definition = resolvedDefinition.value as Record<string, unknown>;
        coerceToolRuntimeNumericFields(
          definition,
          `dependency "${alias}" tool "${toolName}"`,
          resolvedDefinition.errors,
        );
        for (const error of resolvedDefinition.errors) {
          diagnostics.push({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: `dependency:${alias}:tool:${toolName}`,
            message: error,
          });
        }

        toolDefs[toolName] = {
          definition: definition as unknown as ToolDefinitionLocal,
          toolType: toolData.toolType || 'unknown',
        };
      }
    }

    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      continue;
    }

    const resolvedAuthResult = await validateAuthProfileChecks(
      tenantId,
      projectId,
      collectResolvedAuthProfileChecks({ alias, agentIRs, toolDefs, userId }),
      { environment },
    );
    if (!resolvedAuthResult.success) {
      diagnostics.push({
        severity: 'error',
        code: 'AUTH_PROFILE_PREFLIGHT_FAILED',
        source: 'auth-preflight',
        message: `Deploy blocked: ${formatAuthProfileRemediation(resolvedAuthResult.issues)}. Create the required auth profiles before deploying.`,
      });
      continue;
    }

    // ── Rewrite with alias ───────────────────────────────────────
    try {
      const rewriteResult = rewriteModuleIR(alias, agentIRs, toolDefs, allSymbols);

      // Check collisions
      if (rewriteResult.collisions.length > 0) {
        for (const collision of rewriteResult.collisions) {
          diagnostics.push({
            severity: 'error',
            code: 'SYMBOL_COLLISION',
            source: `dependency:${alias}`,
            message: `Symbol "${collision}" collides with an existing symbol`,
          });
        }
        continue;
      }

      // Add mounted agents (keyed by aliased name)
      for (const [aliasedName, agentIR] of Object.entries(rewriteResult.agents)) {
        const originalName =
          Object.entries(rewriteResult.renameMap).find(([, v]) => v === aliasedName)?.[0] ??
          aliasedName;

        mountedAgents[aliasedName] = {
          sourceAgentName: originalName,
          alias,
          moduleProjectId,
          moduleReleaseId,
          ir: agentIR,
        };
        allSymbols.add(aliasedName);
      }

      // Add mounted tools (keyed by aliased name)
      for (const [aliasedName, toolDef] of Object.entries(rewriteResult.tools)) {
        const originalName =
          Object.entries(rewriteResult.renameMap).find(([, v]) => v === aliasedName)?.[0] ??
          aliasedName;

        mountedTools[aliasedName] = {
          sourceToolName: originalName,
          alias,
          moduleProjectId,
          moduleReleaseId,
          definition: toolDef,
        };
        allSymbols.add(aliasedName);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        severity: 'error',
        code: 'REWRITE_FAILED',
        source: `dependency:${alias}`,
        message: `IR rewrite failed: ${message}`,
      });
    }
  }

  // ── Check for blocking diagnostics ─────────────────────────────────
  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  if (hasErrors) {
    return {
      success: false,
      mountedAgentCount: Object.keys(mountedAgents).length,
      mountedToolCount: Object.keys(mountedTools).length,
      diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    };
  }

  // ── Symbol count check ─────────────────────────────────────────────
  const totalMounted = Object.keys(mountedAgents).length + Object.keys(mountedTools).length;
  if (totalMounted > MAX_MOUNTED_SYMBOLS) {
    return {
      success: false,
      mountedAgentCount: Object.keys(mountedAgents).length,
      mountedToolCount: Object.keys(mountedTools).length,
      diagnostics: [
        {
          severity: 'error',
          code: 'TOO_MANY_SYMBOLS',
          source: 'build',
          message: `Total mounted symbols (${totalMounted}) exceeds maximum of ${MAX_MOUNTED_SYMBOLS}`,
        },
      ],
    };
  }

  // ── Build snapshot payload ─────────────────────────────────────────
  const snapshotDependencies: DeploymentModuleDependency[] = resolvedDependencies.map((dep) => ({
    alias: dep.alias,
    moduleProjectId: dep.moduleProjectId,
    moduleReleaseId: dep.moduleReleaseId,
    version: dep.resolvedVersion,
    configOverrides: dep.configOverrides,
  }));

  // Compute snapshot hash from every behavior-affecting mounted artifact.
  const hashInput = stableStringify({
    dependencies: snapshotDependencies,
    mountedAgents,
    mountedTools,
  });

  const snapshotHash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  const snapshotPayload: DeploymentModuleSnapshotPayload = {
    dependencies: snapshotDependencies,
    mountedAgents,
    mountedTools,
    snapshotHash,
  };

  // ── Size check and compression ─────────────────────────────────────
  const jsonPayload = JSON.stringify(snapshotPayload);
  const uncompressedBytes = Buffer.byteLength(jsonPayload, 'utf-8');

  if (uncompressedBytes > MAX_SNAPSHOT_BYTES) {
    return {
      success: false,
      mountedAgentCount: Object.keys(mountedAgents).length,
      mountedToolCount: Object.keys(mountedTools).length,
      diagnostics: [
        {
          severity: 'error',
          code: 'SNAPSHOT_TOO_LARGE',
          source: 'build',
          message: `Snapshot size (${(uncompressedBytes / 1024 / 1024).toFixed(1)} MB) exceeds maximum of ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB`,
        },
      ],
    };
  }

  const compressedPayload = await gzip(Buffer.from(jsonPayload, 'utf-8'));

  // ── Post-build: Atomic version re-verification (LLD Section 10.1) ──
  // Re-check that moduleDependencyVersion hasn't changed during the build.
  // This closes the TOCTOU window between pre-check and snapshot storage.
  const postBuildProject = await Project.findOne({ _id: projectId, tenantId }).lean();
  const postBuildVersion =
    (postBuildProject as Record<string, unknown> | null)?.moduleDependencyVersion ?? 0;
  if (postBuildVersion !== expectedDependencyVersion) {
    return {
      success: false,
      mountedAgentCount: Object.keys(mountedAgents).length,
      mountedToolCount: Object.keys(mountedTools).length,
      diagnostics: [
        {
          severity: 'error',
          code: 'DEPENDENCY_VERSION_MISMATCH',
          source: 'build',
          message: `Dependencies changed during build (expected v${expectedDependencyVersion}, current v${postBuildVersion}). Retry the deployment.`,
        },
      ],
    };
  }

  // ── Collect unique release IDs from mounted entries ─────────────────
  const releaseIdSet = new Set<string>();
  for (const entry of Object.values(mountedAgents)) {
    releaseIdSet.add(entry.moduleReleaseId);
  }
  for (const entry of Object.values(mountedTools)) {
    releaseIdSet.add(entry.moduleReleaseId);
  }
  const moduleReleaseIds = [...releaseIdSet];

  // ── Store snapshot ─────────────────────────────────────────────────
  const snapshot = await DeploymentModuleSnapshot.create({
    tenantId,
    projectId,
    deploymentId,
    snapshotHash,
    moduleReleaseIds,
    compressedPayload,
    createdBy: 'system:deployment-build',
  });

  log.info('Deployment module snapshot created', {
    projectId,
    deploymentId,
    snapshotHash,
    mountedAgents: Object.keys(mountedAgents).length,
    mountedTools: Object.keys(mountedTools).length,
    dependencyCount: resolvedDependencies.length,
    compressedBytes: compressedPayload.length,
    uncompressedBytes,
    durationMs: Date.now() - buildStartMs,
  });

  return {
    success: true,
    snapshotId: (snapshot as Record<string, unknown>)._id?.toString(),
    snapshotHash,
    mountedAgentCount: Object.keys(mountedAgents).length,
    mountedToolCount: Object.keys(mountedTools).length,
    diagnostics,
  };
}

/**
 * Clone an existing deployment module snapshot onto a new deployment.
 * Used by deployment promotion so the promoted deployment preserves the exact
 * frozen module state of its source deployment.
 */
export async function cloneDeploymentModuleSnapshot(
  tenantId: string,
  projectId: string,
  sourceDeploymentId: string,
  targetDeploymentId: string,
  options: CloneDeploymentModuleSnapshotOptions = {},
): Promise<ModuleBuildResult | null> {
  const sourceEnvironment = options.sourceEnvironment?.trim();
  const targetEnvironment = options.targetEnvironment?.trim();
  if (sourceEnvironment && targetEnvironment && sourceEnvironment !== targetEnvironment) {
    log.info('Skipping module snapshot clone across deployment environments', {
      sourceDeploymentId,
      targetDeploymentId,
      sourceEnvironment,
      targetEnvironment,
    });
    return null;
  }

  const { DeploymentModuleSnapshot } = await import('@agent-platform/database/models');

  const sourceSnapshot = await DeploymentModuleSnapshot.findOne({
    tenantId,
    projectId,
    deploymentId: sourceDeploymentId,
  }).lean();

  if (!sourceSnapshot) {
    return null;
  }

  const sourceDoc = sourceSnapshot as Record<string, unknown>;
  const rawCompressedPayload = sourceDoc.compressedPayload;
  const compressedPayload = Buffer.isBuffer(rawCompressedPayload)
    ? Buffer.from(rawCompressedPayload)
    : rawCompressedPayload instanceof Uint8Array
      ? Buffer.from(rawCompressedPayload)
      : Buffer.from(
          new Uint8Array(
            (rawCompressedPayload as { buffer: ArrayBufferLike }).buffer,
            (rawCompressedPayload as { byteOffset?: number }).byteOffset ?? 0,
            (rawCompressedPayload as { byteLength?: number }).byteLength,
          ),
        );

  try {
    const snapshot = await DeploymentModuleSnapshot.create({
      tenantId,
      projectId,
      deploymentId: targetDeploymentId,
      snapshotHash: sourceDoc.snapshotHash,
      moduleReleaseIds: (sourceDoc.moduleReleaseIds as string[] | undefined) ?? [],
      compressedPayload,
      createdBy: 'system:deployment-build',
    });

    log.info('Deployment module snapshot cloned', {
      sourceDeploymentId,
      targetDeploymentId,
      snapshotHash: sourceDoc.snapshotHash,
    });

    return {
      success: true,
      snapshotId: (snapshot as Record<string, unknown>)._id?.toString(),
      snapshotHash: sourceDoc.snapshotHash as string | undefined,
      mountedAgentCount: 0,
      mountedToolCount: 0,
      diagnostics: [],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      mountedAgentCount: 0,
      mountedToolCount: 0,
      diagnostics: [
        {
          severity: 'error',
          code: 'SNAPSHOT_CLONE_FAILED',
          source: 'build',
          message: `Failed to clone module snapshot: ${message}`,
        },
      ],
    };
  }
}
