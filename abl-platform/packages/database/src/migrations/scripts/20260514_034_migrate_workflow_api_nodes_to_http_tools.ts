/**
 * Migration: Convert workflow API nodes to project HTTP tools.
 *
 * Historical workflows could embed HTTP calls directly as `nodeType: "api"`.
 * The steady-state model is project tools plus workflow `tool` nodes, so this
 * migration extracts each API-node HTTP configuration into a same-project
 * `project_tools` record, rewrites the draft workflow version canvas, and
 * syncs the workflow working-copy document that Studio reads.
 *
 * Tool naming follows the requested natural name:
 *   workflowname_apinodename
 *
 * If two API nodes in the same project normalize to the same tool name but
 * carry different HTTP configuration, the migration fails before writing. A
 * single project tool name cannot represent two different configs safely.
 */

import { createHash } from 'crypto';
import mongoose from 'mongoose';
import { uuidv7 } from '../../mongo/base-document.js';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;
type StringIdDocument = { _id: string; [key: string]: unknown };

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ApiBodyType = 'none' | 'json' | 'form' | 'xml' | 'custom';

interface WorkflowNodeDocument {
  id: string;
  nodeType: string;
  name?: string;
  position?: unknown;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface WorkflowDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  nodes?: WorkflowNodeDocument[];
}

interface WorkflowVersionDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  definition?: {
    nodes?: WorkflowNodeDocument[];
    [key: string]: unknown;
  };
  sourceHash?: string;
  createdBy?: string | null;
  deleted?: boolean | null;
}

interface ProjectToolDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  slug: string;
  toolType: string;
  dslContent: string;
  sourceHash: string;
}

interface HeaderEntry {
  key: string;
  value: string;
}

interface ApiNodeConfig {
  method?: string;
  url?: string;
  headers?: unknown;
  body?: unknown;
  auth?: unknown;
  mode?: unknown;
  timeout?: unknown;
}

interface ParameterDef {
  name: string;
  type: string;
  description: string;
}

interface ToolBuildResult {
  dslContent: string;
  sourceHash: string;
  params: Record<string, unknown>;
  parameters: ParameterDef[];
}

interface ToolPlan {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  dslContent: string;
  sourceHash: string;
  createdBy: string;
  existingToolId?: string;
}

interface MigrationStats {
  draftVersionDocsUpdated: number;
  workflowDocsUpdated: number;
  toolsCreated: number;
  toolsReused: number;
  apiNodesConverted: number;
}

const WORKFLOWS_COLLECTION = 'workflows';
const WORKFLOW_VERSIONS_COLLECTION = 'workflow_versions';
const PROJECT_TOOLS_COLLECTION = 'project_tools';
const BATCH_SIZE = 100;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DSL_SIZE = 512 * 1024;

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;
const WORKFLOW_EXPRESSION_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE_WORKFLOW_EXPRESSION_RE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
const TOOL_NATIVE_PLACEHOLDER_ROOTS = new Set([
  'env',
  'secrets',
  'config',
  'input',
  '_context',
  'session',
]);

const DEFAULT_HTTP_CALLBACK_CONFIG = {
  enabled: true,
  location: 'body',
  callbackUrlKey: 'callbackUrl',
  callbackSecretKey: 'callbackSecret',
} as const;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function deepSortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  if (isRecord(obj)) {
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = deepSortKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

function computeWorkflowDefinitionHash(definition: Record<string, unknown>): string {
  return computeHash(JSON.stringify(deepSortKeys(definition))).slice(0, 16);
}

function normalizeToolNamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function normalizeToolName(workflowName: string, nodeName: string): string {
  const base = `${normalizeToolNamePart(workflowName)}_${normalizeToolNamePart(nodeName)}`;
  let name = base.replace(/^_+|_+$/g, '') || 'workflow_api_node';
  if (!/^[a-z]/.test(name)) {
    name = `tool_${name}`;
  }
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    name = name.slice(0, MAX_TOOL_NAME_LENGTH).replace(/_+$/g, '');
  }
  if (!/[a-z0-9]$/.test(name)) {
    name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - 1)}0`;
  }
  if (name.length < 2) {
    name = `${name}_tool`.slice(0, MAX_TOOL_NAME_LENGTH);
  }
  if (!TOOL_NAME_REGEX.test(name)) {
    throw new Error(
      `Unable to generate valid project tool name from "${workflowName}_${nodeName}"`,
    );
  }
  return name;
}

function normalizeParamName(raw: string, used: Set<string>): string {
  let base = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  if (!base) base = 'value';
  if (!/^[a-z_]/.test(base)) base = `p_${base}`;
  if (base.length > 64) base = base.slice(0, 64).replace(/_+$/g, '');

  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function inferParamType(value: unknown): string {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (isRecord(value)) return 'object';
  return 'string';
}

function inlineQuote(value: string): string {
  if (/[\s:#"'{}[\],]/.test(value) || value.length === 0) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function addParam(
  input: {
    rawName: string;
    value: unknown;
    description: string;
  },
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
  },
): string {
  const name = normalizeParamName(input.rawName, state.usedParamNames);
  state.params[name] = input.value;
  state.parameterDefs.push({
    name,
    type: inferParamType(input.value),
    description: input.description,
  });
  return name;
}

function expressionRoot(expression: string): string {
  const trimmed = expression.trim();
  const dotIndex = trimmed.indexOf('.');
  return dotIndex >= 0 ? trimmed.slice(0, dotIndex) : trimmed;
}

function replaceWorkflowExpressions(
  value: string,
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
    expressionParamNames: Map<string, string>;
  },
): string {
  return value.replace(WORKFLOW_EXPRESSION_RE, (match, rawExpression: string) => {
    const expression = rawExpression.trim();
    if (TOOL_NATIVE_PLACEHOLDER_ROOTS.has(expressionRoot(expression))) {
      return match;
    }

    const existingName = state.expressionParamNames.get(expression);
    if (existingName) {
      return `{{input.${existingName}}}`;
    }

    const paramName = addParam(
      {
        rawName: expression.replace(/\./g, '_'),
        value: `{{${expression}}}`,
        description: `Workflow expression migrated from API node: {{${expression}}}`,
      },
      state,
    );
    state.expressionParamNames.set(expression, paramName);
    return `{{input.${paramName}}}`;
  });
}

function hasWorkflowExpression(value: string): boolean {
  WORKFLOW_EXPRESSION_RE.lastIndex = 0;
  return WORKFLOW_EXPRESSION_RE.test(value);
}

function isWholeWorkflowExpression(value: string): boolean {
  return WHOLE_WORKFLOW_EXPRESSION_RE.test(value);
}

function replaceWorkflowExpressionsWithKeyedParams(
  value: string,
  input: {
    rawName: string;
    description: string;
  },
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
  },
): string {
  return value.replace(WORKFLOW_EXPRESSION_RE, (match, rawExpression: string) => {
    const expression = rawExpression.trim();
    if (TOOL_NATIVE_PLACEHOLDER_ROOTS.has(expressionRoot(expression))) {
      return match;
    }

    const paramName = addParam(
      {
        rawName: input.rawName,
        value: `{{${expression}}}`,
        description: input.description,
      },
      state,
    );
    return `{{input.${paramName}}}`;
  });
}

function normalizeHeaders(raw: unknown): HeaderEntry[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => {
      if (!isRecord(entry) || !isNonEmptyString(entry.key)) return [];
      return [
        {
          key: entry.key,
          value: typeof entry.value === 'string' ? entry.value : String(entry.value ?? ''),
        },
      ];
    });
  }

  if (isRecord(raw)) {
    return Object.entries(raw).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : String(value ?? ''),
    }));
  }

  return [];
}

function parseBody(raw: unknown): { type: ApiBodyType; content?: string } {
  if (typeof raw === 'string') {
    return raw.trim().length > 0 ? { type: 'custom', content: raw } : { type: 'none' };
  }

  if (!isRecord(raw)) {
    return { type: 'none' };
  }

  const rawType = raw.type;
  const type: ApiBodyType =
    rawType === 'json' ||
    rawType === 'form' ||
    rawType === 'xml' ||
    rawType === 'custom' ||
    rawType === 'none'
      ? rawType
      : 'none';
  const content = typeof raw.content === 'string' ? raw.content : undefined;
  return content && type !== 'none' ? { type, content } : { type };
}

function parseJsonLike(content: string): unknown {
  const normalizedContent = content
    .replace(
      /([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)/g,
      (_match, prefix: string, key: string, suffix: string) =>
        `${prefix}${JSON.stringify(key)}${suffix}`,
    )
    .replace(
      /(:\s*)(\{\{\s*[^}]+?\s*\}\})(\s*[,}\]])/g,
      (_match, prefix: string, expression: string, suffix: string) =>
        `${prefix}${JSON.stringify(expression)}${suffix}`,
    );

  try {
    return JSON.parse(normalizedContent);
  } catch {
    return JSON.parse(content);
  }
}

function bodyParamRawName(path: string[]): string {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (!/^\d+$/.test(segment)) {
      return segment;
    }
  }
  return 'body';
}

function renderJsonTemplate(
  value: unknown,
  path: string[],
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
  },
  indent = 0,
): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const childIndent = ' '.repeat(indent + 2);
    const closingIndent = ' '.repeat(indent);
    return `[\n${value
      .map(
        (item, index) =>
          `${childIndent}${renderJsonTemplate(item, [...path, String(index)], state, indent + 2)}`,
      )
      .join(',\n')}\n${closingIndent}]`;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const childIndent = ' '.repeat(indent + 2);
    const closingIndent = ' '.repeat(indent);
    return `{\n${entries
      .map(
        ([key, child]) =>
          `${childIndent}${JSON.stringify(key)}: ${renderJsonTemplate(child, [...path, key], state, indent + 2)}`,
      )
      .join(',\n')}\n${closingIndent}}`;
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' && !hasWorkflowExpression(value)) {
    return JSON.stringify(value);
  }

  if (typeof value !== 'string') {
    return JSON.stringify(value);
  }

  const rendered = replaceWorkflowExpressionsWithKeyedParams(
    value,
    {
      rawName: bodyParamRawName(path),
      description: `Body field "${path.join('.') || 'body'}" migrated from API node.`,
    },
    state,
  );
  return isWholeWorkflowExpression(value) ? rendered : JSON.stringify(rendered);
}

function buildJsonBodyTemplate(
  content: string,
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
  },
): string {
  try {
    return renderJsonTemplate(parseJsonLike(content), ['body'], state);
  } catch {
    const paramName = addParam(
      {
        rawName: 'body',
        value: content,
        description: 'Raw JSON body migrated from API node.',
      },
      state,
    );
    return `{{input.${paramName}}}`;
  }
}

function buildFormBodyTemplate(
  content: string,
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
  },
): string {
  const searchParams = new URLSearchParams(content);
  const entries = Array.from(searchParams.entries());
  if (entries.length === 0 && content.trim().length > 0) {
    const paramName = addParam(
      {
        rawName: 'body',
        value: content,
        description: 'Raw form body migrated from API node.',
      },
      state,
    );
    return `{{input.${paramName}}}`;
  }

  return entries
    .map(([key, value]) => {
      const paramName = addParam(
        {
          rawName: key,
          value,
          description: `Form body field "${key}" migrated from API node.`,
        },
        state,
      );
      return `${encodeURIComponent(key)}={{input.${paramName}}}`;
    })
    .join('&');
}

function buildBodyTemplate(
  body: { type: ApiBodyType; content?: string },
  state: {
    usedParamNames: Set<string>;
    params: Record<string, unknown>;
    parameterDefs: ParameterDef[];
  },
): { bodyType?: Exclude<ApiBodyType, 'none'>; bodyTemplate?: string } {
  if (!body.content || body.type === 'none') {
    return {};
  }

  if (body.type === 'json') {
    return { bodyType: 'json', bodyTemplate: buildJsonBodyTemplate(body.content, state) };
  }

  if (body.type === 'form') {
    return { bodyType: 'form', bodyTemplate: buildFormBodyTemplate(body.content, state) };
  }

  const paramName = addParam(
    {
      rawName: 'body',
      value: body.content,
      description: `${body.type.toUpperCase()} body migrated from API node.`,
    },
    state,
  );
  return { bodyType: body.type, bodyTemplate: `{{input.${paramName}}}` };
}

function getApiAuthConfig(config: ApiNodeConfig): {
  authProfileRef?: string;
  authJit?: boolean;
} {
  const auth = isRecord(config.auth) ? config.auth : {};
  const type = typeof auth.type === 'string' ? auth.type : 'none';
  const profileId = isNonEmptyString(auth.profileId) ? auth.profileId.trim() : undefined;

  if (type === 'pre_authorized' && profileId) {
    return { authProfileRef: profileId };
  }

  if (type === 'user_level' && profileId) {
    return { authProfileRef: profileId, authJit: true };
  }

  return {};
}

function buildHttpToolDsl(input: {
  toolName: string;
  workflowName: string;
  nodeName: string;
  config: ApiNodeConfig;
}): ToolBuildResult {
  const state = {
    usedParamNames: new Set<string>(),
    params: {} as Record<string, unknown>,
    parameterDefs: [] as ParameterDef[],
    expressionParamNames: new Map<string, string>(),
  };

  const method: HttpMethod =
    input.config.method === 'POST' ||
    input.config.method === 'PUT' ||
    input.config.method === 'PATCH' ||
    input.config.method === 'DELETE'
      ? input.config.method
      : 'GET';
  const endpoint = replaceWorkflowExpressions(
    typeof input.config.url === 'string' ? input.config.url : '',
    state,
  );
  const headers = normalizeHeaders(input.config.headers).map((header) => ({
    key: replaceWorkflowExpressions(header.key, state),
    value: replaceWorkflowExpressionsWithKeyedParams(
      header.value,
      {
        rawName: header.key,
        description: `Header "${header.key}" migrated from API node.`,
      },
      state,
    ),
  }));
  const body = parseBody(input.config.body);
  const bodyTemplate = buildBodyTemplate(body, state);
  const timeoutSeconds =
    typeof input.config.timeout === 'number' && Number.isFinite(input.config.timeout)
      ? input.config.timeout
      : 60;
  const timeoutMs = Math.max(100, Math.round(timeoutSeconds * 1000));
  const auth = getApiAuthConfig(input.config);

  const paramsSignature = state.parameterDefs
    .map((parameter) => `${parameter.name}: ${parameter.type}`)
    .join(', ');
  const lines = [
    `${input.toolName}(${paramsSignature}) -> object`,
    `  description: ${inlineQuote(
      `Migrated from API node "${input.nodeName}" in workflow "${input.workflowName}".`,
    )}`,
    '  type: http',
  ];

  if (state.parameterDefs.length > 0) {
    lines.push('  params:');
    for (const parameter of state.parameterDefs) {
      lines.push(`    ${parameter.name}:`);
      lines.push(`      description: ${inlineQuote(parameter.description)}`);
    }
  }

  lines.push(`  endpoint: ${inlineQuote(endpoint)}`);
  lines.push(`  method: ${method}`);
  if (auth.authProfileRef) {
    lines.push(`  auth_profile: ${inlineQuote(auth.authProfileRef)}`);
  }
  if (auth.authJit) {
    lines.push('  auth_jit: true');
  }

  if (bodyTemplate.bodyType) {
    lines.push(`  body_type: ${bodyTemplate.bodyType}`);
  }
  if (bodyTemplate.bodyTemplate) {
    lines.push('  body: |');
    for (const bodyLine of bodyTemplate.bodyTemplate.split('\n')) {
      lines.push(`    ${bodyLine}`);
    }
  }

  if (headers.length > 0) {
    lines.push('  headers:');
    for (const header of headers) {
      if (header.key.trim().length > 0) {
        lines.push(`    ${header.key}: ${inlineQuote(header.value)}`);
      }
    }
  }

  if (timeoutMs !== 30_000) {
    lines.push(`  timeout: ${timeoutMs}`);
  }

  const dslContent = lines.join('\n');
  return {
    dslContent,
    sourceHash: computeHash(dslContent),
    params: state.params,
    parameters: state.parameterDefs,
  };
}

function toToolNodeConfig(
  config: ApiNodeConfig,
  toolId: string,
  toolName: string,
  params: Record<string, unknown>,
) {
  const timeout =
    typeof config.timeout === 'number' && Number.isFinite(config.timeout) ? config.timeout : 60;
  const executionMode = config.mode === 'async' ? 'async_wait' : 'sync';
  return {
    toolId,
    toolName,
    params,
    timeout,
    executionMode,
    ...(executionMode === 'async_wait'
      ? {
          callbackConfig: DEFAULT_HTTP_CALLBACK_CONFIG,
        }
      : {}),
  };
}

async function findExistingTool(
  db: Db,
  tenantId: string,
  projectId: string,
  name: string,
): Promise<ProjectToolDocument | null> {
  return db.collection<ProjectToolDocument>(PROJECT_TOOLS_COLLECTION).findOne({
    tenantId,
    projectId,
    name,
  });
}

async function collectMigrationPlan(db: Db): Promise<{
  toolPlans: Map<string, ToolPlan>;
  draftVersionUpdates: Array<{
    id: string;
    definition: Record<string, unknown>;
    sourceHash: string;
  }>;
  workflowUpdates: Array<{
    id: string;
    nodes: WorkflowNodeDocument[];
  }>;
  conflicts: string[];
  stats: MigrationStats;
}> {
  const toolPlans = new Map<string, ToolPlan>();
  const toolCache = new Map<string, ProjectToolDocument | null>();
  const workflowCache = new Map<string, WorkflowDocument | null>();
  const draftNodesByWorkflow = new Map<string, WorkflowNodeDocument[]>();
  const draftVersionUpdates: Array<{
    id: string;
    definition: Record<string, unknown>;
    sourceHash: string;
  }> = [];
  const workflowUpdates: Array<{
    id: string;
    nodes: WorkflowNodeDocument[];
  }> = [];
  const conflicts: string[] = [];
  const stats: MigrationStats = {
    draftVersionDocsUpdated: 0,
    workflowDocsUpdated: 0,
    toolsCreated: 0,
    toolsReused: 0,
    apiNodesConverted: 0,
  };

  function workflowKey(tenantId: string, projectId: string, workflowId: string): string {
    return `${tenantId}:${projectId}:${workflowId}`;
  }

  async function getWorkflow(
    tenantId: string,
    projectId: string,
    workflowId: string,
  ): Promise<WorkflowDocument | null> {
    const key = workflowKey(tenantId, projectId, workflowId);
    if (workflowCache.has(key)) return workflowCache.get(key) ?? null;

    const workflow = await db.collection<WorkflowDocument>(WORKFLOWS_COLLECTION).findOne(
      {
        _id: workflowId,
        tenantId,
        projectId,
      },
      { projection: { name: 1, nodes: 1, tenantId: 1, projectId: 1 } },
    );
    workflowCache.set(key, workflow);
    return workflow;
  }

  async function ensureToolPlan(input: {
    tenantId: string;
    projectId: string;
    workflowName: string;
    node: WorkflowNodeDocument;
    createdBy: string;
  }): Promise<{ toolId: string; toolName: string; build: ToolBuildResult } | null> {
    const nodeName = input.node.name || input.node.id;
    const toolName = normalizeToolName(input.workflowName, nodeName);
    const build = buildHttpToolDsl({
      toolName,
      workflowName: input.workflowName,
      nodeName,
      config: (input.node.config ?? {}) as ApiNodeConfig,
    });
    if (build.dslContent.length > MAX_DSL_SIZE) {
      conflicts.push(
        `Generated DSL for ${input.projectId}/${toolName} exceeds ${MAX_DSL_SIZE} bytes`,
      );
      return null;
    }

    const planKey = `${input.tenantId}:${input.projectId}:${toolName}`;
    const existingPlan = toolPlans.get(planKey);
    if (existingPlan) {
      if (
        existingPlan.sourceHash !== build.sourceHash ||
        existingPlan.dslContent !== build.dslContent
      ) {
        conflicts.push(
          `Conflicting API node configs normalize to tool "${toolName}" in project ${input.projectId}`,
        );
        return null;
      }
      return { toolId: existingPlan.id, toolName, build };
    }

    let existingTool = toolCache.get(planKey);
    if (existingTool === undefined) {
      existingTool = await findExistingTool(db, input.tenantId, input.projectId, toolName);
      toolCache.set(planKey, existingTool);
    }
    if (existingTool) {
      if (
        existingTool.toolType !== 'http' ||
        existingTool.sourceHash !== build.sourceHash ||
        existingTool.dslContent !== build.dslContent
      ) {
        conflicts.push(`Project ${input.projectId} already has non-matching tool "${toolName}"`);
        return null;
      }
      stats.toolsReused += 1;
    } else {
      stats.toolsCreated += 1;
    }

    const toolId = existingTool?._id ?? uuidv7();
    toolPlans.set(planKey, {
      id: toolId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      name: toolName,
      dslContent: build.dslContent,
      sourceHash: build.sourceHash,
      createdBy: input.createdBy || 'migration',
      existingToolId: existingTool?._id,
    });

    return { toolId, toolName, build };
  }

  async function migrateNodes(input: {
    tenantId: string;
    projectId: string;
    workflowName: string;
    nodes: WorkflowNodeDocument[];
    createdBy: string;
  }): Promise<{ changed: boolean; nodes: WorkflowNodeDocument[] }> {
    let changed = false;
    const nodes: WorkflowNodeDocument[] = [];

    for (const node of input.nodes) {
      if (node.nodeType !== 'api') {
        nodes.push(node);
        continue;
      }

      const result = await ensureToolPlan({
        tenantId: input.tenantId,
        projectId: input.projectId,
        workflowName: input.workflowName,
        node,
        createdBy: input.createdBy,
      });
      if (!result) {
        nodes.push(node);
        continue;
      }

      nodes.push({
        ...node,
        nodeType: 'tool',
        config: toToolNodeConfig(
          (node.config ?? {}) as ApiNodeConfig,
          result.toolId,
          result.toolName,
          result.build.params,
        ),
      });
      changed = true;
      stats.apiNodesConverted += 1;
    }

    return { changed, nodes };
  }

  const draftVersionCursor = db
    .collection<WorkflowVersionDocument>(WORKFLOW_VERSIONS_COLLECTION)
    .find(
      {
        version: 'draft',
        deleted: { $ne: true },
        'definition.nodes': { $elemMatch: { nodeType: 'api' } },
      },
      { batchSize: BATCH_SIZE },
    );

  for await (const version of draftVersionCursor) {
    const definition = isRecord(version.definition) ? { ...version.definition } : {};
    const nodes = Array.isArray(definition.nodes)
      ? (definition.nodes as WorkflowNodeDocument[])
      : [];
    const workflow = await getWorkflow(version.tenantId, version.projectId, version.workflowId);
    const workflowName = workflow?.name ?? version.workflowId;
    const migrated = await migrateNodes({
      tenantId: version.tenantId,
      projectId: version.projectId,
      workflowName,
      nodes,
      createdBy: version.createdBy ?? 'migration',
    });
    if (migrated.changed) {
      draftNodesByWorkflow.set(
        workflowKey(version.tenantId, version.projectId, version.workflowId),
        migrated.nodes,
      );
      const nextDefinition = { ...definition, nodes: migrated.nodes };
      draftVersionUpdates.push({
        id: version._id,
        definition: nextDefinition,
        sourceHash: computeWorkflowDefinitionHash(nextDefinition),
      });
      stats.draftVersionDocsUpdated += 1;
    }
  }

  const workflowCursor = db.collection<WorkflowDocument>(WORKFLOWS_COLLECTION).find(
    {
      deleted: { $ne: true },
      nodes: { $elemMatch: { nodeType: 'api' } },
    },
    { batchSize: BATCH_SIZE },
  );

  for await (const workflow of workflowCursor) {
    const key = workflowKey(workflow.tenantId, workflow.projectId, workflow._id);
    const draftNodes = draftNodesByWorkflow.get(key);
    if (draftNodes) {
      workflowUpdates.push({ id: workflow._id, nodes: draftNodes });
      stats.workflowDocsUpdated += 1;
      continue;
    }

    const migrated = await migrateNodes({
      tenantId: workflow.tenantId,
      projectId: workflow.projectId,
      workflowName: workflow.name,
      nodes: Array.isArray(workflow.nodes) ? workflow.nodes : [],
      createdBy: 'migration',
    });
    if (migrated.changed) {
      workflowUpdates.push({ id: workflow._id, nodes: migrated.nodes });
      stats.workflowDocsUpdated += 1;
    }
  }

  return { toolPlans, draftVersionUpdates, workflowUpdates, conflicts, stats };
}

async function applyToolPlans(db: Db, plans: ToolPlan[]): Promise<void> {
  const now = new Date();
  const newPlans = plans.filter((plan) => !plan.existingToolId);
  const operations = [
    ...newPlans.map((plan) => ({
      insertOne: {
        document: {
          _id: plan.id,
          tenantId: plan.tenantId,
          projectId: plan.projectId,
          name: plan.name,
          slug: plan.name,
          toolType: 'http',
          description: null,
          dslContent: plan.dslContent,
          sourceHash: plan.sourceHash,
          variableNamespaceIds: [],
          createdBy: plan.createdBy,
          lastEditedBy: null,
          _v: 1,
          createdAt: now,
          updatedAt: now,
        },
      },
    })),
  ];
  if (operations.length === 0) return;

  await db.collection<StringIdDocument>(PROJECT_TOOLS_COLLECTION).bulkWrite(operations, {
    ordered: false,
  });
}

async function applyDraftVersionUpdates(
  db: Db,
  updates: Array<{ id: string; definition: Record<string, unknown>; sourceHash: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const now = new Date();
  await db.collection<StringIdDocument>(WORKFLOW_VERSIONS_COLLECTION).bulkWrite(
    updates.map((update) => ({
      updateOne: {
        filter: { _id: update.id },
        update: {
          $set: {
            definition: update.definition,
            sourceHash: update.sourceHash,
            updatedAt: now,
          },
        },
      },
    })),
    { ordered: false },
  );
}

async function applyWorkflowUpdates(
  db: Db,
  updates: Array<{ id: string; nodes: WorkflowNodeDocument[] }>,
): Promise<void> {
  if (updates.length === 0) return;
  const now = new Date();
  await db.collection<StringIdDocument>(WORKFLOWS_COLLECTION).bulkWrite(
    updates.map((update) => ({
      updateOne: {
        filter: { _id: update.id },
        update: {
          $set: {
            nodes: update.nodes,
            updatedAt: now,
          },
        },
      },
    })),
    { ordered: false },
  );
}

async function countRemainingApiNodes(db: Db): Promise<{
  draftVersions: number;
  workflows: number;
}> {
  const draftVersions = await db.collection(WORKFLOW_VERSIONS_COLLECTION).countDocuments({
    version: 'draft',
    deleted: { $ne: true },
    'definition.nodes': { $elemMatch: { nodeType: 'api' } },
  });
  const workflows = await db.collection(WORKFLOWS_COLLECTION).countDocuments({
    deleted: { $ne: true },
    nodes: { $elemMatch: { nodeType: 'api' } },
  });
  return { draftVersions, workflows };
}

export const migration: Migration = {
  version: '20260514_034',
  description: 'Migrate workflow API nodes to project HTTP tools',
  transactionMode: 'none',

  async up(db: Db) {
    const plan = await collectMigrationPlan(db);
    if (plan.conflicts.length > 0) {
      throw new Error(
        [
          'Cannot migrate workflow API nodes because conflicts were found:',
          ...plan.conflicts.slice(0, 20).map((conflict) => `- ${conflict}`),
          ...(plan.conflicts.length > 20
            ? [`- ...and ${plan.conflicts.length - 20} more conflict(s)`]
            : []),
        ].join('\n'),
      );
    }

    await applyToolPlans(db, Array.from(plan.toolPlans.values()));
    await applyDraftVersionUpdates(db, plan.draftVersionUpdates);
    await applyWorkflowUpdates(db, plan.workflowUpdates);

    log.info(
      `converted ${plan.stats.apiNodesConverted} API node(s), created ${plan.stats.toolsCreated} tool(s), reused ${plan.stats.toolsReused} tool(s), updated ${plan.stats.draftVersionDocsUpdated} draft workflow version doc(s), updated ${plan.stats.workflowDocsUpdated} workflow doc(s)`,
    );
  },

  async down() {
    log.info(
      'Rollback is a no-op because API-node config is intentionally extracted into project tools and rewritten in-place.',
    );
  },

  async validate(db: Db) {
    const remaining = await countRemainingApiNodes(db);
    if (remaining.draftVersions > 0 || remaining.workflows > 0) {
      return validationFailed('Some workflow API nodes still need migration', remaining);
    }

    return validationPassed('All workflow API nodes have been migrated to tool nodes', remaining);
  },
};

export default migration;
