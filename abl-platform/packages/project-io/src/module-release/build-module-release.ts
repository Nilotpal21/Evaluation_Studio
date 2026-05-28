/**
 * Module Release Builder
 *
 * 9-step pipeline that assembles a module release artifact from project sources.
 * Validates, compiles, strips project-specific identifiers, extracts the contract,
 * and returns a publishable release package.
 *
 * LLD Section 3.1
 */

import { createHash } from 'crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type {
  ModuleReleaseArtifact,
  ModuleReleaseContract,
  ProjectToolType,
} from '@agent-platform/database/models';
import {
  buildAgentCompanionHashInput,
  normalizeAgentCompanionMetadata,
  type AgentCompanionMetadata,
} from '../agent-companion-metadata.js';
import { computeModuleSourceHash } from './source-hash.js';
import { materializeModuleToolDefinition } from './tool-definition.js';

const log = createLogger('module-release-builder');

// ─── Input Types ──────────────────────────────────────────────────────────

export interface ModuleReleaseInput {
  /** The module project's entry agent name */
  entryAgentName: string | null;
  /** Agents in the module: name → DSL content */
  agents: Record<string, string>;
  /** Non-DSL agent companion metadata keyed by agent name */
  agentCompanions?: Record<string, AgentCompanionMetadata | null>;
  /** Optional module-wide precompiled IR keyed by agent name */
  precompiledIR?: Record<string, Record<string, unknown>>;
  /** Standalone behavior profiles in the module: name → DSL content */
  profiles?: Record<string, string>;
  /** Tools in the module: name → { dslContent, toolType } */
  tools: Record<string, { dslContent: string; toolType: ProjectToolType }>;
  /** DSL format: legacy uppercase or yaml */
  dslFormat: 'legacy' | 'yaml';
  /** Whether AgentModelConfig records exist for this project (triggers a warning) */
  hasModelConfigs: boolean;
}

/**
 * Compile function injected by caller.
 * Takes DSL content string and returns compiled AgentIR or null on failure.
 * On failure, should populate the diagnostics array with error details.
 */
export type CompileFn = (dsl: string) => Record<string, unknown> | null;

/**
 * Contract extractor injected by caller.
 * Accepts arrays of agent/tool inputs (name + DSL) and returns the contract.
 * Matches the signature of extractModuleContract in module-contract.ts.
 */
export type ExtractContractFn = (
  agents: Array<{
    name: string;
    description?: string | null;
    dslContent: string;
    compiledIR?: Record<string, unknown>;
  }>,
  tools: Array<{
    name: string;
    toolType: string;
    dslContent: string;
    definition?: Record<string, unknown>;
  }>,
  profiles?: Array<{ name: string; dslContent: string }>,
) => ModuleReleaseContract;

/**
 * Publish safety validator injected by caller.
 * Returns structured validation result with typed issues.
 * Matches the signature of validatePublishSafety in module-publish-safety.ts.
 */
export type ValidatePublishSafetyFn = (
  agents: Array<{ name: string; dslContent: string }>,
  tools: Array<{ name: string; toolType: string; dslContent: string }>,
  profiles?: Array<{ name: string; dslContent: string }>,
) => {
  safe: boolean;
  issues: Array<{
    severity: 'blocking' | 'warning';
    code: string;
    source: string;
    message: string;
  }>;
};

// ─── Output Types ─────────────────────────────────────────────────────────

export interface ModuleReleaseBuildSuccess {
  success: true;
  artifact: ModuleReleaseArtifact;
  compiledIR: Record<string, Record<string, unknown>>;
  contract: ModuleReleaseContract;
  sourceHash: string;
  warnings: string[];
}

export interface ModuleReleaseBuildFailure {
  success: false;
  errors: string[];
  warnings: string[];
}

export type ModuleReleaseBuildResult = ModuleReleaseBuildSuccess | ModuleReleaseBuildFailure;

// ─── Builder ──────────────────────────────────────────────────────────────

/**
 * Build a module release artifact from project sources.
 *
 * Steps:
 * 1. Validate at least one agent exists
 * 2. Validate entryAgentName is set and non-null
 * 3. Compile each agent DSL → IR
 * 4. Strip variableNamespaceIds from tool references in compiled IR
 * 5. Store dslContent and per-agent sourceHash in artifact
 * 6. For each tool: store dslContent, toolType, and per-tool sourceHash
 * 7. Run publish safety validation
 * 8. Extract contract
 * 9. Compute sourceHash and check for model config warning
 */
export function buildModuleRelease(
  input: ModuleReleaseInput,
  compileFn: CompileFn,
  extractContractFn: ExtractContractFn,
  validatePublishSafetyFn: ValidatePublishSafetyFn,
): ModuleReleaseBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const agentCompanions = input.agentCompanions ?? {};
  const precompiledIR = input.precompiledIR ?? {};

  // Step 1: Validate at least one agent exists
  const agentNames = Object.keys(input.agents);
  const profiles = input.profiles ?? {};
  if (agentNames.length === 0) {
    return { success: false, errors: ['Module must contain at least one agent'], warnings };
  }

  // Step 2: Validate entryAgentName is set and non-null
  if (!input.entryAgentName) {
    return {
      success: false,
      errors: ['Module must have an entry agent name set (project.entryAgentName)'],
      warnings,
    };
  }

  if (!input.agents[input.entryAgentName]) {
    return {
      success: false,
      errors: [
        `Entry agent '${input.entryAgentName}' not found in module agents: [${agentNames.join(', ')}]`,
      ],
      warnings,
    };
  }

  // Step 3: Compile each agent DSL → IR
  const compiledIR: Record<string, Record<string, unknown>> = {};
  const artifactAgents: Record<
    string,
    {
      dslContent: string;
      sourceHash: string;
      companion?: AgentCompanionMetadata;
    }
  > = {};

  for (const [agentName, dslContent] of Object.entries(input.agents)) {
    let ir: Record<string, unknown> | null;
    try {
      ir = precompiledIR[agentName] ?? compileFn(dslContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Agent '${agentName}' compilation threw an error: ${message}`);
      continue;
    }

    if (!ir) {
      errors.push(`Agent '${agentName}' compilation failed (compiler returned null)`);
      continue;
    }

    // Step 4: Strip variableNamespaceIds from tool references in compiled IR
    const strippedIR = stripVariableNamespaceIds(ir);
    compiledIR[agentName] = strippedIR;

    // Step 5: Store dslContent and per-agent sourceHash in artifact
    const normalizedCompanion = normalizeAgentCompanionMetadata(agentCompanions[agentName]);
    const agentHashPayload = {
      dslContent,
      companion: buildAgentCompanionHashInput(normalizedCompanion),
    };
    const agentHash = createHash('sha256')
      .update(JSON.stringify(agentHashPayload))
      .digest('hex')
      .slice(0, 16);
    artifactAgents[agentName] = normalizedCompanion
      ? { dslContent, sourceHash: agentHash, companion: normalizedCompanion }
      : { dslContent, sourceHash: agentHash };
  }

  // If any agent failed to compile, return errors
  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Step 6: For each tool: store dslContent, toolType, and per-tool sourceHash
  const artifactTools: Record<
    string,
    {
      dslContent: string;
      toolType: ProjectToolType;
      sourceHash: string;
      definition?: Record<string, unknown>;
    }
  > = {};
  const artifactProfiles: Record<string, { dslContent: string; sourceHash: string }> = {};

  for (const [profileName, dslContent] of Object.entries(profiles)) {
    const profileHash = createHash('sha256').update(dslContent).digest('hex').slice(0, 16);
    artifactProfiles[profileName] = {
      dslContent,
      sourceHash: profileHash,
    };
  }

  for (const [toolName, toolDef] of Object.entries(input.tools)) {
    const toolHash = createHash('sha256').update(toolDef.dslContent).digest('hex').slice(0, 16);
    try {
      artifactTools[toolName] = {
        dslContent: toolDef.dslContent,
        toolType: toolDef.toolType,
        sourceHash: toolHash,
        definition: materializeModuleToolDefinition(toolDef.dslContent, toolDef.toolType),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Tool '${toolName}' materialization failed: ${message}`);
    }
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Step 7: Run publish safety validation (always required — never skip secret detection)
  const safetyAgents = Object.entries(input.agents).map(([name, dslContent]) => ({
    name,
    dslContent,
  }));
  const safetyTools = Object.entries(input.tools).map(([name, def]) => ({
    name,
    toolType: def.toolType,
    dslContent: def.dslContent,
  }));
  const safetyProfiles = Object.entries(profiles).map(([name, dslContent]) => ({
    name,
    dslContent,
  }));
  const safetyResult = validatePublishSafetyFn(safetyAgents, safetyTools, safetyProfiles);
  const blockingIssues = safetyResult.issues.filter((i) => i.severity === 'blocking');
  const warningIssues = safetyResult.issues.filter((i) => i.severity === 'warning');
  if (!safetyResult.safe) {
    return {
      success: false,
      errors: blockingIssues.map((i) => `[${i.code}] ${i.source}: ${i.message}`),
      warnings: warningIssues.map((i) => `[${i.code}] ${i.source}: ${i.message}`),
    };
  }
  warnings.push(...warningIssues.map((i) => `[${i.code}] ${i.source}: ${i.message}`));

  // Step 8: Extract contract (pass compiled IR and tool definitions for enriched extraction)
  const contractAgents = Object.entries(input.agents).map(([name, dslContent]) => ({
    name,
    dslContent,
    ...(compiledIR[name] ? { compiledIR: compiledIR[name] } : {}),
  }));
  const contractTools = Object.entries(input.tools).map(([name, def]) => ({
    name,
    toolType: def.toolType,
    dslContent: def.dslContent,
    ...(artifactTools[name]?.definition ? { definition: artifactTools[name].definition } : {}),
  }));
  const contractProfiles = Object.entries(profiles).map(([name, dslContent]) => ({
    name,
    dslContent,
  }));
  const contract = extractContractFn(contractAgents, contractTools, contractProfiles);

  // Step 9: Compute sourceHash and check for model config warning
  const agentDslMap: Record<string, string> = {};
  for (const [name, content] of Object.entries(input.agents)) {
    agentDslMap[name] = content;
  }
  const toolDslMap: Record<string, string> = {};
  for (const [name, def] of Object.entries(input.tools)) {
    toolDslMap[name] = def.dslContent;
  }
  const sourceHash = computeModuleSourceHash(
    input.entryAgentName,
    agentDslMap,
    toolDslMap,
    profiles,
    agentCompanions,
  );

  if (input.hasModelConfigs) {
    warnings.push(
      'Model configuration is not included in the release artifact. Consumers must configure models independently.',
    );
  }

  const artifact: ModuleReleaseArtifact = {
    dslFormat: input.dslFormat,
    entryAgentName: input.entryAgentName,
    agents: artifactAgents,
    ...(Object.keys(artifactProfiles).length > 0 ? { profiles: artifactProfiles } : {}),
    tools: artifactTools,
  };

  log.info('Module release built successfully', {
    agentCount: agentNames.length,
    profileCount: Object.keys(profiles).length,
    toolCount: Object.keys(input.tools).length,
    sourceHash,
    warningCount: warnings.length,
  });

  return {
    success: true,
    artifact,
    compiledIR,
    contract,
    sourceHash,
    warnings,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Recursively strip variable namespace IDs from an IR object.
 * These IDs are project-scoped and must not leak into module artifacts.
 */
const VARIABLE_NAMESPACE_KEYS = new Set(['variableNamespaceIds', 'variable_namespace_ids']);

function stripVariableNamespaceIds(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (VARIABLE_NAMESPACE_KEYS.has(key)) {
      continue; // strip
    }
    result[key] = stripDeep(value);
  }
  return result;
}

/** Recursively strip variableNamespaceIds from any nested structure, including arrays-of-arrays. */
function stripDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripDeep(item));
  }
  if (value && typeof value === 'object') {
    return stripVariableNamespaceIds(value as Record<string, unknown>);
  }
  return value;
}
