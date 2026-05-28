/**
 * Resolve Tool Implementations
 *
 * Batch-resolves tool names from parsed agent DSL into compiled IR bindings.
 * Replaces resolve-tool-links.ts (which resolved USE TOOL: slug@version
 * from the old two-collection model).
 *
 * In the new DSL-native tool system:
 * - Agent DSL contains tool signatures only (name, params, return type, type)
 * - Implementation (endpoint, auth, code, server) lives in project_tools.dslContent
 * - This function looks up project_tools by name, parses dslContent → AST,
 *   compiles per-type bindings, and returns IR-ready resolved tools.
 *
 * Lives in @agent-platform/shared because:
 * - @abl/compiler cannot depend on shared (circular dep)
 * - Resolution requires DB access (project_tools collection)
 * - Called by version-service, deployment-resolver, topology API
 */

import type {
  NormalizedMCPServerConfig,
  McpServerConfigForIR,
  RawMCPServerConfig,
} from '../types/mcp-server.js';
import {
  parseSignatureLine,
  parseDslProperties,
  parseDslParamMetadata,
  parseReturnTypeString,
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildMcpBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  extractPipeBlock,
  parseOptionalRuntimeNumber,
  parseDslToolCompaction,
  type HttpBindingIRLocal,
  type SandboxBindingIRLocal,
  type McpBindingIRLocal,
  type SearchAIBindingIRLocal,
  type WorkflowBindingLocal,
  type ToolReturnTypeLocal,
  type RuntimeNumericValue,
  type ToolCompactionConfigLocal,
} from './dsl-property-parser.js';
import {
  isProjectToolType,
  validateProjectToolDslForPersistence,
} from './project-tool-persistence.js';
import { computeToolRuntimeMetadataHash } from './runtime-metadata.js';
import { validateSearchAIToolBinding } from './validate-searchai-tool-binding.js';
import {
  validateWorkflowToolBinding,
  type TriggerRegistrationsRepo,
  type WorkflowVersionsRepo,
  type WorkflowsRepo,
} from './validate-workflow-tool-binding.js';
import { computeSourceHash } from '../utils/hash.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolveToolImplInput {
  tenantId: string;
  projectId: string;
  /** Agent name → tool names from parsed DSL TOOLS sections */
  toolsByAgent: Map<string, string[]>;
}

export interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  location: string;
  message: string;
}

/**
 * A resolved tool implementation with compiled IR binding.
 * Produced by resolveToolImplementations, consumed by the compiler's merge step.
 */
export interface ResolvedToolImpl {
  name: string;
  toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';
  projectToolId: string;
  sourceHash: string;
  description: string | null;
  dslContent: string;
  /** Compiled binding — exactly one of these will be populated based on toolType */
  httpBinding?: HttpBindingIRLocal;
  sandboxBinding?: SandboxBindingIRLocal;
  mcpBinding?: McpBindingIRLocal;
  searchaiBinding?: SearchAIBindingIRLocal;
  workflowBinding?: WorkflowBindingLocal;
  /** Variable namespace IDs this tool is linked to (for env var scoping at runtime) */
  variableNamespaceIds?: string[];
}

// ─── Local ToolDefinition type (mirrors @abl/compiler ToolDefinition) ────────
// Declared locally to avoid circular dep: shared → compiler

export interface ToolParameterLocal {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  /** Nested object properties (recursive) */
  properties?: ToolParameterLocal[];
  /** Array item schema */
  items?: { type: string; enum?: unknown[] };
}

export interface ToolHintsLocal {
  cacheable: boolean;
  latency: 'fast' | 'medium' | 'slow';
  parallelizable: boolean;
  side_effects: boolean;
  requires_auth: boolean;
  timeout?: RuntimeNumericValue;
}

export interface ConnectorBindingIRLocal {
  connector: string;
  action: string;
}

export interface ToolDefinitionLocal {
  name: string;
  description: string;
  parameters: ToolParameterLocal[];
  returns: ToolReturnTypeLocal;
  hints: ToolHintsLocal;
  tool_type?: 'http' | 'mcp' | 'sandbox' | 'searchai' | 'connector' | 'workflow';
  http_binding?: HttpBindingIRLocal;
  mcp_binding?: McpBindingIRLocal;
  sandbox_binding?: SandboxBindingIRLocal;
  searchai_binding?: SearchAIBindingIRLocal;
  connector_binding?: ConnectorBindingIRLocal;
  workflow_binding?: WorkflowBindingLocal;
  compaction?: ToolCompactionConfigLocal;
  /** Variable namespace IDs this tool is linked to (for env var scoping at runtime) */
  variable_namespace_ids?: string[];
}

export interface ToolSnapshotEntry {
  name: string;
  projectToolId: string;
  sourceHash: string;
  runtimeMetadataHash?: string;
  toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';
  description: string | null;
  dslContent: string;
}

export interface ResolveToolImplResult {
  resolvedByAgent: Map<string, ToolDefinitionLocal[]>;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
  snapshotEntries: ToolSnapshotEntry[];
  timings: ResolutionTimings;
}

export interface ResolutionTimings {
  dbQueryMs: number;
  redisCacheLookupMs: number;
  redisCacheHits: number;
  redisCacheMisses: number;
  compilationMs: number;
  redisCacheWriteMs: number;
  totalMs: number;
}

/** DI dependencies — injected by the caller, not imported directly */
export interface ResolveToolImplDeps {
  /**
   * Individual get/setex — cluster-safe (no CROSSSLOT risk).
   * Replaces the previous mget/mset interface.
   */
  redis?: {
    get(key: string): Promise<string | null>;
    setex(key: string, seconds: number, value: string): Promise<unknown>;
  };
  mcpServerConfigLoader?: (
    tenantId: string,
    projectId: string,
  ) => Promise<NormalizedMCPServerConfig[]>;
  /**
   * Raw loader for IR baking — returns DEK-envelope ciphertext in encrypted fields.
   * MUST be used for all compile-time IR generation.
   * Injected by version-service.ts, execution/types.ts, project-aware-compile.ts,
   * apps/studio/src/app/api/abl/compile/route.ts, and topology/route.ts.
   */
  mcpServerConfigRawLoader?: (tenantId: string, projectId: string) => Promise<RawMCPServerConfig[]>;
  /** Optional trace event emitter for observability */
  traceEmitter?: (event: {
    type: string;
    data: Record<string, unknown>;
    durationMs?: number;
  }) => void;
  /**
   * Optional connector tool resolver. When a tool name matches the
   * "connector.action" pattern (e.g., "gmail.send_email") and is not found
   * in the project_tools collection, this function is called to generate a
   * ToolDefinitionLocal from the ConnectorRegistry.
   */
  connectorToolResolver?: (
    connectorName: string,
    actionName: string,
  ) => Promise<ToolDefinitionLocal | null>;
  /**
   * Optional module tool resolver. When a tool name matches the
   * "alias__toolname" pattern (e.g., "sai__get_weather_forecast") and is not
   * found in the project_tools collection, this function is called to resolve
   * the tool from the imported module release artifact.
   */
  moduleToolResolver?: (
    mountedName: string,
    alias: string,
    originalToolName: string,
  ) => Promise<ToolDefinitionLocal | null>;
}

// ─── Redis cache key ─────────────────────────────────────────────────────────

const CACHE_PREFIX = 'tool_compiled:v3:';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/* v8 ignore start -- cache key construction only used within resolveToolImplementations */
function cacheKey(
  tenantId: string,
  projectId: string,
  toolName: string,
  sourceHash: string,
  metadataHash: string,
): string {
  return `${CACHE_PREFIX}${tenantId}:${projectId}:${toolName}:${sourceHash}:${metadataHash}`;
}
/* v8 ignore stop */

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Batch-resolve tool names to compiled IR bindings.
 *
 * Algorithm:
 * 1. Collect unique tool names across all agents
 * 2. Batch DB query: project_tools.find({ name: { $in: [...] }, tenantId, projectId })
 * 3. Redis cache check: MGET tool_compiled:{tenantId}:{projectId}:{hash} ...
 * 4. For uncached tools: parse dslContent, compile per-type binding
 * 5. MCP tools: batch-load mcp_server_configs, bake server_config into binding
 * 6. Cache compiled results: MSET with 24h TTL
 * 7. Map resolved tools to agents, emit E721 for missing names
 *
 * @param input - tenantId, projectId, and toolsByAgent map
 * @param deps - Injected dependencies (Redis client, MCP config loader)
 */
/* v8 ignore start -- integration function requiring DB/Redis, tested via integration tests */
export async function resolveToolImplementations(
  input: ResolveToolImplInput,
  deps: ResolveToolImplDeps = {},
): Promise<ResolveToolImplResult> {
  const totalStart = Date.now();
  const { tenantId, projectId, toolsByAgent } = input;
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];
  const resolvedByAgent = new Map<string, ToolDefinitionLocal[]>();
  const timings: ResolutionTimings = {
    dbQueryMs: 0,
    redisCacheLookupMs: 0,
    redisCacheHits: 0,
    redisCacheMisses: 0,
    compilationMs: 0,
    redisCacheWriteMs: 0,
    totalMs: 0,
  };

  // Step 1: Collect unique tool names
  const allNames = new Set<string>();
  for (const [, names] of toolsByAgent) {
    for (const name of names) {
      allNames.add(name);
    }
  }

  deps.traceEmitter?.({
    type: 'tool.resolution.start',
    data: {
      toolCount: allNames.size,
      agentCount: toolsByAgent.size,
    },
  });

  if (allNames.size === 0) {
    timings.totalMs = Date.now() - totalStart;
    return { resolvedByAgent, errors, warnings, snapshotEntries: [], timings };
  }

  // Step 2: Batch DB query
  const dbStart = Date.now();
  const { ProjectTool } = await import('@agent-platform/database/models');
  const rawDbTools = await ProjectTool.find({
    tenantId,
    projectId,
    name: { $in: [...allNames] },
  }).lean();
  const dbTools = rawDbTools.map((tool) => {
    const actualSourceHash = computeSourceHash(tool.dslContent);
    if (actualSourceHash === tool.sourceHash) {
      return tool;
    }

    warnings.push({
      severity: 'warning',
      code: 'W_TOOL_SOURCE_HASH_STALE',
      location: `tool:${tool.name}`,
      message: `Tool '${tool.name}' sourceHash is stale; runtime cache identity was derived from current DSL content.`,
    });
    return {
      ...tool,
      sourceHash: actualSourceHash,
    };
  });
  timings.dbQueryMs = Date.now() - dbStart;

  // Index by name for O(1) lookup
  const toolByName = new Map(dbTools.map((t) => [t.name, t]));

  // MCP bindings bake server config into IR, so the server config snapshot must
  // participate in cache identity before Redis lookup, not only during compile.
  let mcpConfigMap = new Map<string, McpServerConfigForIR>();
  let mcpServerConfigsForHash: McpServerConfigForIR[] = [];
  const hasMcpTools = dbTools.some((t) => t.toolType === 'mcp');
  if (hasMcpTools && (deps.mcpServerConfigRawLoader || deps.mcpServerConfigLoader)) {
    const configs = deps.mcpServerConfigRawLoader
      ? await deps.mcpServerConfigRawLoader(tenantId, projectId)
      : await deps.mcpServerConfigLoader!(tenantId, projectId);
    mcpConfigMap = new Map(configs.map((c) => [c.name, c]));
    mcpServerConfigsForHash = configs;
  }

  const computeRuntimeMetadataHash = (tool: (typeof dbTools)[number]) =>
    computeToolRuntimeMetadataHash({
      variableNamespaceIds: tool.variableNamespaceIds,
      mcpServerConfigs: tool.toolType === 'mcp' ? mcpServerConfigsForHash : undefined,
    });

  // Step 3: Redis cache check
  const toolsToCompile: typeof dbTools = [];
  const compiledByToolName = new Map<string, ResolvedToolImpl>();

  if (deps.redis && dbTools.length > 0) {
    const cacheStart = Date.now();
    const keys = dbTools.map((t) =>
      cacheKey(tenantId, projectId, t.name, t.sourceHash, computeRuntimeMetadataHash(t)),
    );
    const cached = await Promise.all(keys.map((k) => deps.redis!.get(k)));
    timings.redisCacheLookupMs = Date.now() - cacheStart;

    for (let i = 0; i < dbTools.length; i++) {
      const tool = dbTools[i];
      const cachedValue = cached[i];
      if (cachedValue) {
        try {
          const parsed = JSON.parse(cachedValue) as ResolvedToolImpl;
          if (
            parsed.name === tool.name &&
            parsed.toolType === tool.toolType &&
            parsed.sourceHash === tool.sourceHash
          ) {
            const cacheValidationError = await validateCachedResolvedTool(parsed, {
              tenantId,
              projectId,
            });
            if (cacheValidationError) {
              errors.push({
                severity: 'error',
                code: 'E725',
                location: `tool:${tool.name}`,
                message: `Failed to compile tool '${tool.name}': ${cacheValidationError}`,
              });
              timings.redisCacheHits++;
              continue;
            }
            compiledByToolName.set(tool.name, parsed);
            deps.traceEmitter?.({
              type: 'tool.compilation.per_tool',
              data: {
                toolName: tool.name,
                toolType: tool.toolType,
                fromCache: true,
              },
            });
            timings.redisCacheHits++;
          } else {
            toolsToCompile.push(tool);
            timings.redisCacheMisses++;
          }
        } catch {
          // Corrupted cache entry — recompile
          toolsToCompile.push(tool);
          timings.redisCacheMisses++;
        }
      } else {
        toolsToCompile.push(tool);
        timings.redisCacheMisses++;
      }
    }
  } else {
    // No Redis — compile all
    toolsToCompile.push(...dbTools);
    timings.redisCacheMisses = dbTools.length;
  }

  // Step 4: Compile uncached tools
  if (toolsToCompile.length > 0) {
    const compileStart = Date.now();

    // Compile each tool (parallel for performance)
    const compileResults = await Promise.all(
      toolsToCompile.map(async (tool) => {
        try {
          const resolved = await compileProjectTool(tool, mcpConfigMap, { tenantId, projectId });
          return { tool, resolved, error: null };
        } catch (err) {
          return { tool, resolved: null, error: err as Error };
        }
      }),
    );

    for (const { tool, resolved, error } of compileResults) {
      if (error) {
        errors.push({
          severity: 'error',
          code: 'E725',
          location: `tool:${tool.name}`,
          message: `Failed to compile tool '${tool.name}': ${error.message}`,
        });
        continue;
      }
      if (resolved) {
        compiledByToolName.set(tool.name, resolved);
        deps.traceEmitter?.({
          type: 'tool.compilation.per_tool',
          data: {
            toolName: tool.name,
            toolType: tool.toolType,
            fromCache: false,
          },
        });
      }
    }

    timings.compilationMs = Date.now() - compileStart;

    // Step 6: Cache newly compiled results
    if (deps.redis && compiledByToolName.size > 0) {
      const cacheWriteStart = Date.now();
      const newEntries: [string, string][] = [];
      for (const { tool, resolved } of compileResults) {
        if (resolved) {
          newEntries.push([
            cacheKey(
              tenantId,
              projectId,
              tool.name,
              tool.sourceHash,
              computeRuntimeMetadataHash(tool),
            ),
            JSON.stringify(resolved),
          ]);
        }
      }
      if (newEntries.length > 0) {
        await Promise.all(newEntries.map(([k, v]) => deps.redis!.setex(k, CACHE_TTL_SECONDS, v)));
      }
      timings.redisCacheWriteMs = Date.now() - cacheWriteStart;
    }
  }

  // Step 7: Map resolved tools to agents
  const snapshotMap = new Map<string, ToolSnapshotEntry>();

  for (const [agentName, names] of toolsByAgent) {
    const agentTools: ToolDefinitionLocal[] = [];

    for (const name of names) {
      const dbTool = toolByName.get(name);
      if (!dbTool) {
        // Connector tool fallback: if name matches "connector.action" pattern,
        // try to resolve from the ConnectorRegistry via the injected resolver.
        const dotIndex = name.indexOf('.');
        if (dotIndex > 0 && deps.connectorToolResolver) {
          const connectorName = name.substring(0, dotIndex);
          const actionName = name.substring(dotIndex + 1);
          const connectorTool = await deps.connectorToolResolver(connectorName, actionName);
          if (connectorTool) {
            agentTools.push(connectorTool);
            deps.traceEmitter?.({
              type: 'tool.resolution.connector_fallback',
              data: { toolName: name, connectorName, actionName },
            });
            continue;
          }
        }

        // Module tool fallback: if name matches "alias__toolname" pattern,
        // try to resolve from the imported module release artifact.
        const dunderIndex = name.indexOf('__');
        if (dunderIndex > 0 && deps.moduleToolResolver) {
          const alias = name.substring(0, dunderIndex);
          const originalToolName = name.substring(dunderIndex + 2);
          const moduleTool = await deps.moduleToolResolver(name, alias, originalToolName);
          if (moduleTool) {
            agentTools.push(moduleTool);
            deps.traceEmitter?.({
              type: 'tool.resolution.module_fallback',
              data: { toolName: name, alias, originalToolName },
            });
            continue;
          }
        }

        errors.push({
          severity: 'error',
          code: 'E721',
          location: `agent:${agentName}.tool:${name}`,
          message: `Tool '${name}' not found in project. Create it in the Tool Library first.`,
        });
        continue;
      }

      const resolved = compiledByToolName.get(dbTool.name);
      if (!resolved) {
        // Compilation failed — error already emitted in step 4
        continue;
      }

      agentTools.push(toToolDefinition(resolved));

      // Build snapshot entry (deduplicated by name)
      if (!snapshotMap.has(name)) {
        snapshotMap.set(name, {
          name: dbTool.name,
          projectToolId: dbTool._id,
          sourceHash: dbTool.sourceHash,
          runtimeMetadataHash: computeRuntimeMetadataHash(dbTool),
          toolType: dbTool.toolType as ToolSnapshotEntry['toolType'],
          description: dbTool.description,
          dslContent: dbTool.dslContent,
        });
      }
    }

    resolvedByAgent.set(agentName, agentTools);
  }

  timings.totalMs = Date.now() - totalStart;

  deps.traceEmitter?.({
    type: 'tool.resolution.complete',
    data: {
      resolvedCount: compiledByToolName.size,
      missingCount: errors.filter((e) => e.code === 'E721').length,
      errorCount: errors.length,
      warningCount: warnings.length,
      cacheHits: timings.redisCacheHits,
      cacheMisses: timings.redisCacheMisses,
    },
    durationMs: timings.totalMs,
  });

  return {
    resolvedByAgent,
    errors,
    warnings,
    snapshotEntries: [...snapshotMap.values()],
    timings,
  };
}
/* v8 ignore stop */

// ─── Per-Tool Compilation ────────────────────────────────────────────────────

/* v8 ignore start -- compileProjectTool is only called from resolveToolImplementations (integration code) */
/**
 * Compile a single project_tool to its ResolvedToolImpl.
 * Parses dslContent, extracts binding fields, builds IR binding.
 */
async function compileProjectTool(
  tool: {
    _id: string;
    name: string;
    toolType: string;
    description: string | null;
    dslContent: string;
    sourceHash: string;
    variableNamespaceIds?: string[];
  },
  mcpConfigMap: Map<string, McpServerConfigForIR>,
  context: { tenantId: string; projectId: string },
): Promise<ResolvedToolImpl> {
  if (!isProjectToolType(tool.toolType)) {
    throw new Error(`Unsupported tool type: ${tool.toolType}`);
  }

  const validation = validateProjectToolDslForPersistence({
    tenantId: context.tenantId,
    projectId: context.projectId,
    name: tool.name,
    toolType: tool.toolType,
    dslContent: tool.dslContent,
  });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const props = parseDslProperties(tool.dslContent);

  const base: ResolvedToolImpl = {
    name: tool.name,
    toolType: tool.toolType,
    projectToolId: tool._id,
    sourceHash: tool.sourceHash,
    description: tool.description,
    dslContent: tool.dslContent,
    variableNamespaceIds: tool.variableNamespaceIds,
  };

  switch (tool.toolType) {
    case 'http':
      base.httpBinding = buildHttpBindingFromProps(props, tool.dslContent);
      break;
    case 'sandbox':
      base.sandboxBinding = buildSandboxBindingFromProps(props, tool.dslContent);
      break;
    case 'mcp':
      base.mcpBinding = buildMcpBindingFromProps(props, tool.name, {
        mcpConfigMap,
        dslContent: tool.dslContent,
      });
      break;
    case 'searchai': {
      const binding = buildSearchAIBindingFromProps(props);
      const pipeBlock = extractPipeBlock(tool.dslContent, 'search_instructions');
      if (pipeBlock) binding.searchInstructions = pipeBlock;
      await validateSearchAIBindingForProject(binding, context);
      base.searchaiBinding = binding;
      break;
    }
    case 'workflow': {
      const binding = buildWorkflowBindingFromProps(props);
      await validateWorkflowBindingForProject(binding, context);
      base.workflowBinding = binding;
      break;
    }
    default:
      throw new Error(`Unsupported tool type: ${tool.toolType}`);
  }

  return base;
}

async function validateCachedResolvedTool(
  resolved: ResolvedToolImpl,
  context: { tenantId: string; projectId: string },
): Promise<string | null> {
  try {
    if (resolved.toolType === 'searchai') {
      if (!resolved.searchaiBinding) {
        return 'SearchAI tool is missing SearchAI binding';
      }
      await validateSearchAIBindingForProject(resolved.searchaiBinding, context);
    }

    if (resolved.toolType === 'workflow') {
      if (!resolved.workflowBinding) {
        return 'Workflow tool is missing workflow binding';
      }
      await validateWorkflowBindingForProject(resolved.workflowBinding, context);
    }

    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function validateSearchAIBindingForProject(
  binding: SearchAIBindingIRLocal,
  context: { tenantId: string; projectId: string },
): Promise<void> {
  const { SearchIndex } = await import('@agent-platform/database/models');
  const result = await validateSearchAIToolBinding(binding, {
    tenantId: context.tenantId,
    projectId: context.projectId,
    searchIndexesRepo: {
      findOne: (filter) => SearchIndex.findOne(filter).lean(),
    },
  });
  if (!result.valid) {
    throw new Error(result.error.message);
  }
}

async function validateWorkflowBindingForProject(
  binding: WorkflowBindingLocal,
  context: { tenantId: string; projectId: string },
): Promise<void> {
  const { Workflow, WorkflowVersion, TriggerRegistration } =
    await import('@agent-platform/database/models');
  const workflowsRepo: WorkflowsRepo = {
    findOne: (filter) => Workflow.findOne(filter).lean(),
  };
  const workflowVersionsRepo: WorkflowVersionsRepo = {
    findOne: (filter) => WorkflowVersion.findOne(filter).lean(),
  };
  const triggerRegistrationsRepo: TriggerRegistrationsRepo = {
    findOne: (filter) => TriggerRegistration.findOne(filter).lean(),
  };
  const result = await validateWorkflowToolBinding(
    {
      workflowId: binding.workflowId,
      workflowVersionId: binding.workflowVersionId,
      workflowVersion: binding.workflowVersion,
      triggerId: binding.triggerId,
    },
    {
      tenantId: context.tenantId,
      projectId: context.projectId,
      workflowsRepo,
      workflowVersionsRepo,
      triggerRegistrationsRepo,
    },
  );
  if (!result.valid) {
    throw new Error(result.error.message);
  }
}
/* v8 ignore stop */

/**
 * Convert a ResolvedToolImpl to a ToolDefinitionLocal.
 * Parses parameters + return type from dslContent signature line,
 * maps camelCase bindings to snake_case, and adds hints.
 */
export function toToolDefinition(resolved: ResolvedToolImpl): ToolDefinitionLocal {
  const sig = parseSignatureLine(resolved.dslContent);
  const props = parseDslProperties(resolved.dslContent);
  const paramMeta = parseDslParamMetadata(resolved.dslContent);
  const compaction = parseDslToolCompaction(resolved.dslContent);

  return {
    name: resolved.name,
    description: resolved.description || '',
    parameters: sig.parameters.map((p) => {
      const meta = paramMeta.get(p.name);
      const param: ToolParameterLocal = {
        name: p.name,
        type: p.type,
        required: p.required,
        ...(meta?.description && { description: meta.description }),
        ...(meta?.enum && { enum: meta.enum }),
        ...(meta?.default !== undefined && { default: meta.default }),
      };
      // Parse objectSchema JSON into structured properties/items for IR
      if (meta?.schema) {
        try {
          const parsed = JSON.parse(meta.schema) as Record<string, unknown>;
          if (p.type === 'array') {
            param.items = parsed as { type: string; enum?: unknown[] };
          } else if (p.type === 'object' && typeof parsed === 'object') {
            param.properties = Object.entries(parsed).map(([name, rawProp]) => {
              const prop = rawProp as Record<string, unknown>;
              return {
                name,
                type: (prop.type as string) || 'string',
                required: false,
                ...(prop.description ? { description: prop.description as string } : {}),
              };
            });
          }
        } catch {
          // Skip invalid schema JSON
        }
      }
      return param;
    }),
    returns: parseReturnTypeString(sig.returnType),
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: (props.method || 'GET') !== 'GET',
      requires_auth: (!!props.auth && props.auth !== 'none') || !!props.auth_profile,
      timeout: parseOptionalRuntimeNumber(props.timeout, 'Tool hint timeout'),
    },
    tool_type: resolved.toolType,
    ...(props.auth_profile ? { auth_profile_ref: props.auth_profile } : {}),
    ...(props.auth_jit === 'true' ? { jit_auth: true } : {}),
    ...(props.connection ? { connection_mode: props.connection as 'per_user' | 'shared' } : {}),
    ...(props.consent ? { consent_mode: props.consent as 'preflight' | 'inline' } : {}),
    http_binding: resolved.httpBinding,
    mcp_binding: resolved.mcpBinding,
    sandbox_binding: resolved.sandboxBinding,
    searchai_binding: resolved.searchaiBinding,
    workflow_binding: resolved.workflowBinding,
    compaction,
    variable_namespace_ids: resolved.variableNamespaceIds,
  };
}

// Re-export buildModuleToolResolver so consumers importing from this file
// (via package.json exports mapping) can use it directly.
export { buildModuleToolResolver } from './resolve-module-tool.js';
