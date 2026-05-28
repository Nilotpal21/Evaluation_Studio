/**
 * Load Project Tools as IR
 *
 * Simplified runtime loader that queries project_tools collection and builds
 * ToolDefinition IR objects.
 *
 * NOTE: The primary tool resolution path is now `resolveToolImplementations()`
 * from @agent-platform/shared/tools/resolve, which is called before compilation
 * and merges tools via `compilerOptions.resolvedToolImplementations`. This file
 * remains as a utility for cases that need raw tool definitions without the
 * full resolution pipeline.
 *
 * Uses shared DSL parsing utilities from @agent-platform/shared to avoid
 * duplicating parsing logic (G3/G10 fix).
 */

import type {
  ToolDefinition,
  ToolParameter,
  HttpBindingIR,
  McpBindingIR,
  SandboxBindingIR,
  SearchAIBindingIR,
  WorkflowBindingIR,
} from '@abl/compiler';
import {
  ProjectTool,
  SearchIndex,
  TriggerRegistration,
  Workflow,
  WorkflowVersion,
} from '@agent-platform/database/models';
import {
  parseSignatureLine,
  parseDslProperties,
  extractPipeBlock,
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildMcpBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseDslParamMetadata,
  isProjectToolType,
  validateProjectToolDslForPersistence,
  validateSearchAIToolBinding,
  validateWorkflowToolBinding,
  parseOptionalRuntimeNumber,
  type SearchAIIndexesRepo,
  type TriggerRegistrationsRepo,
  type WorkflowVersionsRepo,
  type WorkflowsRepo,
} from '@agent-platform/shared/tools';
import type { NormalizedMCPServerConfig } from '@agent-platform/shared';

/**
 * Load tools from the project_tools collection and convert to IR format.
 *
 * @param tenantId - Tenant ID
 * @param projectId - Project ID
 * @param toolNames - Set of tool names to load
 * @returns Object with tools array in ToolDefinition IR format
 */
export async function loadProjectToolsAsIR(
  tenantId: string,
  projectId: string,
  toolNames: Set<string>,
  options?: {
    mcpConfigMap?: Map<string, NormalizedMCPServerConfig>;
  },
): Promise<{ tools: ToolDefinition[] }> {
  if (toolNames.size === 0) {
    return { tools: [] };
  }

  // Query project tools by name
  const dbTools = await ProjectTool.find({
    tenantId,
    projectId,
    name: { $in: [...toolNames] },
  }).lean();

  // Convert each tool to IR format using shared parsers
  const tools: ToolDefinition[] = await Promise.all(
    dbTools.map(async (dbTool) => {
      if (!isProjectToolType(dbTool.toolType)) {
        throw new Error(
          `Invalid project tool "${dbTool.name}": unsupported toolType ${dbTool.toolType}`,
        );
      }

      const validation = validateProjectToolDslForPersistence({
        tenantId,
        projectId,
        name: dbTool.name,
        toolType: dbTool.toolType,
        dslContent: dbTool.dslContent,
      });
      if (!validation.valid) {
        throw new Error(`Invalid project tool "${dbTool.name}": ${validation.message}`);
      }

      const props = parseDslProperties(dbTool.dslContent);
      const sig = parseSignatureLine(dbTool.dslContent);

      const parsedTimeout = parseOptionalRuntimeNumber(props.timeout, 'Tool hint timeout');
      const timeout = typeof parsedTimeout === 'number' ? parsedTimeout : undefined;

      // Parse rich parameter metadata from params: block
      const paramMeta = parseDslParamMetadata(dbTool.dslContent);

      const tool: ToolDefinition = {
        name: dbTool.name,
        description: dbTool.description || '',
        parameters: sig.parameters.map((p) => {
          const meta = paramMeta.get(p.name);
          const param: ToolParameter = {
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
        returns: {
          type: sig.returnType,
        },
        hints: {
          cacheable: false,
          latency: 'medium',
          parallelizable: true,
          side_effects: (props.method || 'GET') !== 'GET',
          requires_auth: (props.auth ?? 'none') !== 'none' || Boolean(props.auth_profile),
          timeout,
        },
        tool_type: dbTool.toolType as 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow',
        ...(props.auth_profile ? { auth_profile_ref: props.auth_profile } : {}),
        ...(props.auth_jit === 'true' ? { jit_auth: true } : {}),
        ...(props.connection ? { connection_mode: props.connection as 'per_user' | 'shared' } : {}),
        ...(props.consent ? { consent_mode: props.consent as 'preflight' | 'inline' } : {}),
        variable_namespace_ids: (dbTool as Record<string, unknown>).variableNamespaceIds as
          | string[]
          | undefined,
      };

      // Add type-specific binding based on toolType
      switch (dbTool.toolType) {
        case 'http':
          tool.http_binding = buildHttpBindingFromProps(
            props,
            dbTool.dslContent,
          ) as unknown as HttpBindingIR;
          break;
        case 'sandbox':
          tool.sandbox_binding = buildSandboxBindingFromProps(
            props,
            dbTool.dslContent,
          ) as unknown as SandboxBindingIR;
          break;
        case 'mcp':
          tool.mcp_binding = buildMcpBindingFromProps(props, dbTool.name, {
            dslContent: dbTool.dslContent,
            mcpConfigMap: options?.mcpConfigMap,
          }) as unknown as McpBindingIR;
          break;
        case 'searchai':
          await attachSearchAIBinding(tool, props, tenantId, projectId, dbTool.dslContent);
          break;
        case 'workflow':
          await attachWorkflowBinding(tool, props, tenantId, projectId);
          break;
      }

      return tool;
    }),
  );

  return { tools };
}

// ─── SearchAI Binding ───────────────────────────────────────────────────────

async function attachSearchAIBinding(
  tool: ToolDefinition,
  props: Record<string, string>,
  tenantId: string,
  projectId: string,
  dslContent?: string,
): Promise<void> {
  const binding = buildSearchAIBindingFromProps(props);
  if (dslContent) {
    const pipeBlock = extractPipeBlock(dslContent, 'search_instructions');
    if (pipeBlock) binding.searchInstructions = pipeBlock;
  }
  if (binding.searchInstructions === '|' || binding.searchInstructions === '') {
    binding.searchInstructions = undefined;
  }
  const searchIndexesRepo: SearchAIIndexesRepo = {
    findOne: (filter) => SearchIndex.findOne(filter).lean(),
  };
  const bindingValidation = await validateSearchAIToolBinding(binding, {
    tenantId,
    projectId,
    searchIndexesRepo,
  });
  if (!bindingValidation.valid) {
    throw new Error(`Invalid SearchAI tool "${tool.name}": ${bindingValidation.error.message}`);
  }

  tool.searchai_binding = binding as unknown as SearchAIBindingIR;
  // Enrich parameter descriptions for SearchAI tools so the LLM knows how and
  // when to use filters, queryType, etc.
  enrichSearchAIParamDescriptions(tool);
}

// ─── Workflow Binding ────────────────────────────────────────────────────────

/** Input variable type mapping from workflow schema types to JSON Schema. */
const WORKFLOW_TYPE_MAP: Record<string, Record<string, unknown>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  json: {}, // no schema constraint
};

const JSON_SCHEMA_TYPE_TO_TOOL_TYPE: Record<string, string> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  object: 'object',
  array: 'array',
};

interface WorkflowParameterJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
}

function deriveToolParametersFromJsonSchema(
  schema: unknown,
): { parameters: ToolParameter[]; schema: WorkflowParameterJsonSchema } | null {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  const objectSchema = schema as {
    properties?: unknown;
    required?: unknown;
  };
  if (!objectSchema.properties || typeof objectSchema.properties !== 'object') {
    return null;
  }

  const requiredNames = Array.isArray(objectSchema.required)
    ? objectSchema.required.filter((name): name is string => typeof name === 'string')
    : [];
  const required = new Set(
    Array.isArray(objectSchema.required)
      ? objectSchema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const properties = objectSchema.properties as Record<string, unknown>;

  return {
    parameters: Object.entries(properties).map(([name, rawProperty]) => {
      const property =
        rawProperty && typeof rawProperty === 'object'
          ? (rawProperty as Record<string, unknown>)
          : {};
      const schemaType = typeof property.type === 'string' ? property.type : 'object';
      const param: ToolParameter = {
        name,
        type: JSON_SCHEMA_TYPE_TO_TOOL_TYPE[schemaType] ?? schemaType,
        required: required.has(name),
      };

      if (typeof property.description === 'string') {
        param.description = property.description;
      }
      if (Array.isArray(property.enum)) {
        param.enum = property.enum;
      }
      if (property.default !== undefined) {
        param.default = property.default;
      }

      return param;
    }),
    schema: {
      type: 'object',
      properties,
      required: requiredNames,
    },
  };
}

/**
 * Attach a workflow binding to a ToolDefinition.
 *
 * Loads the workflow document to extract inputVariables from the start node,
 * then derives a JSON Schema for the tool's parameters.
 */
async function attachWorkflowBinding(
  tool: ToolDefinition,
  props: Record<string, string>,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const binding = buildWorkflowBindingFromProps(props);
  const workflowsRepo: WorkflowsRepo = {
    findOne: (filter) => Workflow.findOne(filter).lean(),
  };
  const workflowVersionsRepo: WorkflowVersionsRepo = {
    findOne: (filter) => WorkflowVersion.findOne(filter).lean(),
  };
  const triggerRegistrationsRepo: TriggerRegistrationsRepo = {
    findOne: (filter) => TriggerRegistration.findOne(filter).lean(),
  };
  const bindingValidation = await validateWorkflowToolBinding(
    {
      workflowId: binding.workflowId,
      workflowVersionId: binding.workflowVersionId,
      workflowVersion: binding.workflowVersion,
      triggerId: binding.triggerId,
    },
    {
      tenantId,
      projectId,
      workflowsRepo,
      workflowVersionsRepo,
      triggerRegistrationsRepo,
    },
  );
  if (!bindingValidation.valid) {
    throw new Error(`Invalid workflow tool "${tool.name}": ${bindingValidation.error.message}`);
  }

  // Load workflow to derive parameter schema from start node inputVariables.
  // If the tool pins to a WorkflowVersion, use that frozen definition instead
  // of the mutable workflow container so the runtime schema matches execution.
  const workflow = await Workflow.findOne({
    _id: binding.workflowId,
    tenantId,
    projectId,
  }).lean();
  const workflowVersion = binding.workflowVersionId
    ? await WorkflowVersion.findOne({
        _id: binding.workflowVersionId,
        workflowId: binding.workflowId,
        tenantId,
        projectId,
        deleted: { $ne: true },
      }).lean()
    : binding.workflowVersion
      ? await WorkflowVersion.findOne({
          workflowId: binding.workflowId,
          version: binding.workflowVersion,
          tenantId,
          projectId,
          deleted: { $ne: true },
        }).lean()
      : null;

  if (workflow || workflowVersion) {
    const definition = workflowVersion
      ? ((workflowVersion.definition ?? {}) as {
          inputSchema?: unknown;
          nodes?: Array<{ nodeType: string; config?: Record<string, unknown> }>;
        })
      : (workflow as {
          inputSchema?: unknown;
          nodes?: Array<{ nodeType: string; config?: Record<string, unknown> }>;
        });
    const schemaParameters = deriveToolParametersFromJsonSchema(definition.inputSchema);
    if (schemaParameters && schemaParameters.parameters.length > 0) {
      tool.parameters = schemaParameters.parameters;
      tool.derivedParameterSchema = schemaParameters.schema;
    }

    const startNode = definition.nodes?.find(
      (n: { nodeType: string; config?: Record<string, unknown> }) => n.nodeType === 'start',
    );
    if (!schemaParameters?.parameters.length && startNode) {
      const config = startNode.config as {
        inputVariables?: Array<{
          name: string;
          type: string;
          required: boolean;
          description?: string;
        }>;
      };
      const inputVars = config.inputVariables ?? [];

      if (inputVars.length > 0) {
        const properties: Record<string, Record<string, unknown>> = {};
        const required: string[] = [];

        for (const v of inputVars) {
          const schema = WORKFLOW_TYPE_MAP[v.type] ?? {};
          properties[v.name] = {
            ...schema,
            ...(v.description ? { description: v.description } : {}),
          };
          if (v.required) {
            required.push(v.name);
          }
        }

        // Override the DSL-derived parameters with the workflow-derived schema
        tool.parameters = inputVars.map((v) => ({
          name: v.name,
          type: v.type === 'json' ? 'object' : v.type,
          required: v.required,
          ...(v.description ? { description: v.description } : {}),
        }));

        // Also attach the raw JSON Schema for consumers that need it
        tool.derivedParameterSchema = {
          type: 'object',
          properties,
          required,
        };
      }
    }

    // Derive mode from trigger if not explicitly set
    if (!props.mode && workflow?.triggers) {
      const trigger = workflow.triggers.find((t: { id: string }) => t.id === binding.triggerId);
      if (trigger) {
        const triggerConfig = trigger.config as { mode?: 'sync' | 'async' } | undefined;
        if (triggerConfig?.mode) {
          binding.mode = triggerConfig.mode;
        }
      }
    }
  }

  tool.workflow_binding = {
    workflowId: binding.workflowId,
    workflowVersionId: binding.workflowVersionId,
    workflowVersion: binding.workflowVersion,
    triggerId: binding.triggerId,
    mode: binding.mode,
    paramMapping: binding.paramMapping ?? {},
    timeoutMs: binding.timeoutMs,
  } as WorkflowBindingIR;
}

// ─── SearchAI Parameter Enrichment ────────────────────────────────────────

/** Detailed parameter descriptions for SearchAI tools.
 *  These are injected into the tool's input_schema so the LLM reads them
 *  natively alongside each parameter — no need to duplicate in the main
 *  description body. Keeps the main description lean (~300-500 tokens). */
const SEARCHAI_PARAM_DESCRIPTIONS: Record<string, string> = {
  query:
    'The natural-language search query. Required. In multi-turn conversations, include relevant context from prior turns so the search engine has enough information.',
  queryType:
    'Search strategy. Values: structured, hybrid, semantic, vector, aggregation. ' +
    '"structured": filter-only queries (e.g. "show PDFs", "list open P0 bugs"). ' +
    '"semantic": conceptual similarity (e.g. "how does auth work"). ' +
    '"hybrid" (default): combines filters + semantic (e.g. "high priority bugs about login"). ' +
    '"aggregation": counts/stats (e.g. "count bugs by status"). ' +
    'Omit to let the pipeline auto-classify.',
  filters:
    'Metadata filters to narrow results. Array of {field, operator, value} objects. ' +
    'Operators: equals, contains, in, greater_than, less_than. ' +
    'Only add a filter when the user provides a concrete value (e.g. "PDFs" → {field:"source_type", operator:"equals", value:"pdf"}). ' +
    'Never use a field name as the value. If the user asks generically (e.g. "list authors"), put it in the query instead. ' +
    'In multi-turn conversations, carry forward relevant filters from prior turns.',
  aggregation:
    'Aggregation spec for queryType "aggregation". Format: {"field": "<field_name>", "function": "count"}. ' +
    'Functions: count, sum, avg, min, max. Always include when using queryType "aggregation", otherwise only a total count is returned.',
  function:
    'Aggregation function when using queryType "aggregation". Values: count, sum, avg, min, max.',
  rerank:
    'Set true to rerank results for better relevance on semantic/hybrid queries. Adds ~100-200ms latency. ' +
    'Skip for structured or aggregation queries, or when latency is critical. Default: false.',
  skipPreprocessing:
    'Set true to skip typo correction and synonym expansion. Use when you have already rephrased the query from conversation context. Default: false.',
  skipVocabularyResolution:
    'Set true to skip vocabulary resolution. Use when you provide explicit filters. Default: false.',
  thought: 'Your reasoning about why this search call is the right action. Keep under 1024 tokens.',
};

export function enrichSearchAIParamDescriptions(tool: ToolDefinition): void {
  if (!tool.parameters) return;
  for (const param of tool.parameters) {
    if (typeof param === 'string') continue;
    const enriched = SEARCHAI_PARAM_DESCRIPTIONS[param.name];
    if (enriched && (!param.description || param.description === param.name)) {
      param.description = enriched;
    }
  }
}
