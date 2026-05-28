import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  ProjectTool,
  ToolTestEndpoint,
  type IProjectTool,
  type IToolTestEndpoint,
} from '@agent-platform/database/models';
import {
  parseDslParamMetadata,
  parseReturnTypeString,
  parseSignatureLine,
  type ToolReturnTypeLocal,
} from '@agent-platform/shared/tools';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('tool-test-endpoint-service');

const DEFAULT_PUBLIC_ORIGIN = 'http://localhost:5173';
const CAPABILITY_BYTES = 24;
const INVOKE_CAPABILITY_PREFIX = 'tti';
const SPEC_CAPABILITY_PREFIX = 'tts';

type CapabilityKind = 'invoke' | 'spec';
type JsonPrimitive = string | number | boolean | null;
type JsonObject = Record<string, unknown>;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

interface LoadedProjectTool extends Pick<
  IProjectTool,
  '_id' | 'tenantId' | 'projectId' | 'name' | 'description' | 'dslContent'
> {}

interface CapabilityResolution {
  endpoint: IToolTestEndpoint;
  tool: LoadedProjectTool;
}

export interface ToolTestEndpointUrls {
  invokeUrl: string;
  specUrl: string;
}

export interface ToolTestEndpointCapabilities {
  invokeCapability: string;
  specCapability: string;
  urls: ToolTestEndpointUrls;
}

export interface UpsertToolTestEndpointInput {
  tenantId: string;
  projectId: string;
  projectToolId: string;
  toolName: string;
  staticResponse: JsonValue;
  sampleInput?: Record<string, unknown> | null;
  createdBy: string;
  lastEditedBy?: string | null;
  rotateCapabilities?: boolean;
  invokeCapability?: string;
  specCapability?: string;
}

export interface ToolTestEndpointUpsertResult {
  endpoint: IToolTestEndpoint;
  urls: ToolTestEndpointUrls;
}

export interface ToolTestEndpointFixture {
  endpointId: string;
  projectToolId: string;
  toolName: string;
  status: IToolTestEndpoint['status'];
  staticResponse: JsonValue;
  sampleInput: Record<string, unknown> | null;
  urls: ToolTestEndpointUrls;
  version: number;
  updatedAt: Date;
}

export interface UpdateToolTestEndpointFixtureInput {
  tenantId: string;
  projectId: string;
  projectToolId: string;
  staticResponse?: JsonValue;
  sampleInput?: Record<string, unknown> | null;
  actorId: string;
}

export class ToolTestEndpointInputError extends Error {
  readonly code = 'TOOL_TEST_ENDPOINT_INPUT_INVALID' as const;
  readonly messages: string[];

  constructor(messages: string[]) {
    super(messages.join(' '));
    this.name = 'ToolTestEndpointInputError';
    this.messages = messages;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return parsed.origin !== 'null' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function generateCapability(kind: CapabilityKind): string {
  const prefix = kind === 'invoke' ? INVOKE_CAPABILITY_PREFIX : SPEC_CAPABILITY_PREFIX;
  return `${prefix}_${crypto.randomBytes(CAPABILITY_BYTES).toString('base64url')}`;
}

function coercePrimitiveSchema(type: string): JsonObject {
  switch (type.toLowerCase()) {
    case 'string':
      return { type: 'string' };
    case 'number':
    case 'integer':
    case 'int':
    case 'float':
      return { type: 'number' };
    case 'boolean':
    case 'bool':
      return { type: 'boolean' };
    case 'object':
      return { type: 'object', additionalProperties: true };
    case 'array':
      return { type: 'array', items: {} };
    default:
      return { type: 'string' };
  }
}

function toolReturnTypeToJsonSchema(returnType: ToolReturnTypeLocal): JsonObject {
  if (returnType.type === 'array') {
    return {
      type: 'array',
      items: returnType.items ? toolReturnTypeToJsonSchema(returnType.items) : {},
    };
  }

  if (returnType.type === 'object') {
    const properties: JsonObject = {};
    const required: string[] = [];

    for (const [fieldName, fieldType] of Object.entries(returnType.fields ?? {})) {
      properties[fieldName] = toolReturnTypeToJsonSchema(fieldType);
      if (!fieldType.optional) {
        required.push(fieldName);
      }
    }

    return {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return coercePrimitiveSchema(returnType.type);
}

function inferJsonSchemaFromSample(value: unknown): JsonObject {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? inferJsonSchemaFromSample(value[0]) : {},
    };
  }

  if (isRecord(value)) {
    const properties: JsonObject = {};
    const required = Object.keys(value);

    for (const [key, childValue] of Object.entries(value)) {
      properties[key] = inferJsonSchemaFromSample(childValue);
    }

    return {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return value === null ? { type: 'null' } : {};
  }
}

function parseParamSchemaOverride(rawSchema: string | undefined): JsonObject | null {
  if (!rawSchema) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawSchema);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildParameterSchema(
  parameter: { name: string; type: string },
  metadata:
    | { description?: string; enum?: string[]; default?: string; schema?: string }
    | undefined,
): JsonObject {
  const override = parseParamSchemaOverride(metadata?.schema);
  if (override) {
    return override;
  }

  const parsedType = parseReturnTypeString(parameter.type);
  const schema = toolReturnTypeToJsonSchema(parsedType);

  if (metadata?.description) {
    schema.description = metadata.description;
  }
  if (metadata?.enum && metadata.enum.length > 0) {
    schema.enum = metadata.enum;
  }
  if (metadata?.default !== undefined) {
    schema.default = metadata.default;
  }

  return schema;
}

function buildRequestBodySchema(tool: LoadedProjectTool): JsonObject {
  const signature = parseSignatureLine(tool.dslContent);
  const paramMetadata = parseDslParamMetadata(tool.dslContent);
  const properties: JsonObject = {};
  const required: string[] = [];

  for (const parameter of signature.parameters) {
    properties[parameter.name] = buildParameterSchema(parameter, paramMetadata.get(parameter.name));
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

function buildResponseSchema(tool: LoadedProjectTool, endpoint: IToolTestEndpoint): JsonObject {
  if (endpoint.staticResponse !== undefined) {
    return inferJsonSchemaFromSample(endpoint.staticResponse);
  }

  const signature = parseSignatureLine(tool.dslContent);
  return toolReturnTypeToJsonSchema(parseReturnTypeString(signature.returnType));
}

function validateValueAgainstType(
  value: unknown,
  typeSpec: ToolReturnTypeLocal,
  path: string,
): string[] {
  if (typeSpec.type === 'array') {
    if (!Array.isArray(value)) {
      return [`${path} must be an array`];
    }

    if (!typeSpec.items) {
      return [];
    }

    return value.flatMap((entry, index) =>
      validateValueAgainstType(entry, typeSpec.items!, `${path}[${index}]`),
    );
  }

  if (typeSpec.type === 'object') {
    if (!isRecord(value)) {
      return [`${path} must be an object`];
    }

    const errors: string[] = [];
    const fields = typeSpec.fields ?? {};

    for (const [fieldName, fieldType] of Object.entries(fields)) {
      const childPath = `${path}.${fieldName}`;
      const childValue = value[fieldName];

      if (childValue === undefined) {
        if (!fieldType.optional) {
          errors.push(`${childPath} is required`);
        }
        continue;
      }

      errors.push(...validateValueAgainstType(childValue, fieldType, childPath));
    }

    for (const extraField of Object.keys(value)) {
      if (!(extraField in fields)) {
        errors.push(`${path}.${extraField} is not declared in the tool contract`);
      }
    }

    return errors;
  }

  switch (typeSpec.type.toLowerCase()) {
    case 'string':
      return typeof value === 'string' ? [] : [`${path} must be a string`];
    case 'number':
    case 'integer':
    case 'int':
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
        ? []
        : [`${path} must be a number`];
    case 'boolean':
    case 'bool':
      return typeof value === 'boolean' ? [] : [`${path} must be a boolean`];
    case 'object':
      return isRecord(value) ? [] : [`${path} must be an object`];
    case 'array':
      return Array.isArray(value) ? [] : [`${path} must be an array`];
    default:
      return [];
  }
}

function validateInputAgainstTool(tool: LoadedProjectTool, input: JsonObject): string[] {
  const signature = parseSignatureLine(tool.dslContent);
  const declaredParamNames = new Set(signature.parameters.map((parameter) => parameter.name));
  const errors: string[] = [];

  for (const parameter of signature.parameters) {
    const value = input[parameter.name];

    if (value === undefined) {
      if (parameter.required) {
        errors.push(`${parameter.name} is required`);
      }
      continue;
    }

    const parsedType = parseReturnTypeString(parameter.type);
    errors.push(...validateValueAgainstType(value, parsedType, parameter.name));
  }

  for (const extraField of Object.keys(input)) {
    if (!declaredParamNames.has(extraField)) {
      errors.push(`${extraField} is not declared in the tool contract`);
    }
  }

  return errors;
}

async function findEndpointByCapability(
  kind: CapabilityKind,
  capability: string,
): Promise<CapabilityResolution | null> {
  await ensureDb();

  const capabilityHash = hashCapability(capability);
  const capabilityField = kind === 'invoke' ? 'invokeCapabilityHash' : 'specCapabilityHash';
  const endpoint = (await ToolTestEndpoint.findOne({
    [capabilityField]: capabilityHash,
    status: 'active',
  }).lean()) as IToolTestEndpoint | null;

  if (!endpoint) {
    return null;
  }

  const tool = (await ProjectTool.findOne({
    _id: endpoint.projectToolId,
    tenantId: endpoint.tenantId,
    projectId: endpoint.projectId,
  })
    .select('_id tenantId projectId name description dslContent')
    .lean()) as LoadedProjectTool | null;

  if (!tool) {
    log.warn('Public tool test endpoint is missing its project tool', {
      endpointId: endpoint._id,
      projectToolId: endpoint.projectToolId,
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
    });
    return null;
  }

  return { endpoint, tool };
}

function buildOpenApiDocument(
  resolution: CapabilityResolution,
  origin = resolveToolTestPublicOrigin(),
): JsonObject {
  const { endpoint, tool } = resolution;
  const requestSchema = buildRequestBodySchema(tool);
  const responseSchema = buildResponseSchema(tool, endpoint);
  const invokePath = `/api/public/tool-test/${endpoint.invokeCapability}`;

  return {
    openapi: '3.1.0',
    info: {
      title: `${tool.name} Test API`,
      version: '1.0.0',
      description:
        tool.description ??
        `Studio-hosted public Test API endpoint for the ${tool.name} project tool.`,
    },
    servers: [{ url: origin }],
    paths: {
      [invokePath]: {
        post: {
          operationId: tool.name,
          summary: tool.description ?? `Invoke ${tool.name}`,
          requestBody: {
            required: Object.keys(requestSchema.properties as JsonObject).length > 0,
            content: {
              'application/json': {
                schema: requestSchema,
                ...(endpoint.sampleInput ? { example: endpoint.sampleInput } : {}),
              },
            },
          },
          responses: {
            '200': {
              description: 'Deterministic static response for the bootstrapped project tool.',
              content: {
                'application/json': {
                  schema: responseSchema,
                  example: endpoint.staticResponse,
                },
              },
            },
            '400': {
              description: 'Input validation failed for the tool contract.',
            },
            '404': {
              description: 'Capability not found.',
            },
          },
        },
      },
    },
  };
}

function serializeToolTestEndpointFixture(endpoint: IToolTestEndpoint): ToolTestEndpointFixture {
  return {
    endpointId: endpoint._id,
    projectToolId: endpoint.projectToolId,
    toolName: endpoint.toolName,
    status: endpoint.status,
    staticResponse: endpoint.staticResponse as JsonValue,
    sampleInput: endpoint.sampleInput,
    urls: buildToolTestEndpointUrls({
      invokeCapability: endpoint.invokeCapability,
      specCapability: endpoint.specCapability,
    }),
    version: endpoint._v,
    updatedAt: endpoint.updatedAt,
  };
}

export function hashCapability(capability: string): string {
  return crypto.createHash('sha256').update(capability).digest('hex');
}

export function resolveToolTestPublicOrigin(): string {
  return (
    normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeOrigin(process.env.NEXTAUTH_URL) ??
    DEFAULT_PUBLIC_ORIGIN
  );
}

export function buildToolTestEndpointUrls(params: {
  invokeCapability: string;
  specCapability: string;
  origin?: string;
}): ToolTestEndpointUrls {
  const origin = params.origin ?? resolveToolTestPublicOrigin();
  return {
    invokeUrl: `${origin}/api/public/tool-test/${params.invokeCapability}`,
    specUrl: `${origin}/api/public/tool-test/specs/${params.specCapability}/openapi.json`,
  };
}

export function generateToolTestEndpointCapabilities(
  origin?: string,
): ToolTestEndpointCapabilities {
  const invokeCapability = generateCapability('invoke');
  const specCapability = generateCapability('spec');

  return {
    invokeCapability,
    specCapability,
    urls: buildToolTestEndpointUrls({
      invokeCapability,
      specCapability,
      origin,
    }),
  };
}

export async function upsertToolTestEndpoint(
  input: UpsertToolTestEndpointInput,
): Promise<ToolTestEndpointUpsertResult> {
  await ensureDb();

  const existing = (await ToolTestEndpoint.findOne({
    tenantId: input.tenantId,
    projectId: input.projectId,
    projectToolId: input.projectToolId,
  }).lean()) as IToolTestEndpoint | null;

  const invokeCapability =
    !input.rotateCapabilities && existing?.invokeCapability
      ? existing.invokeCapability
      : (input.invokeCapability ?? generateCapability('invoke'));
  const specCapability =
    !input.rotateCapabilities && existing?.specCapability
      ? existing.specCapability
      : (input.specCapability ?? generateCapability('spec'));

  const payload = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    projectToolId: input.projectToolId,
    toolName: input.toolName,
    invokeCapability,
    invokeCapabilityHash: hashCapability(invokeCapability),
    specCapability,
    specCapabilityHash: hashCapability(specCapability),
    status: 'active' as const,
    responseMode: 'static_json' as const,
    staticResponse: input.staticResponse,
    sampleInput: input.sampleInput ?? null,
    createdBy: existing?.createdBy ?? input.createdBy,
    lastEditedBy: input.lastEditedBy ?? existing?.lastEditedBy ?? null,
    _v: (existing?._v ?? 0) + 1,
  };

  const endpoint = existing
    ? ((await ToolTestEndpoint.findOneAndUpdate(
        {
          _id: existing._id,
          tenantId: input.tenantId,
          projectId: input.projectId,
        },
        { $set: payload },
        { new: true },
      ).lean()) as IToolTestEndpoint | null)
    : ((await ToolTestEndpoint.create(payload)).toObject() as IToolTestEndpoint);

  if (!endpoint) {
    throw new Error('Failed to upsert tool test endpoint');
  }

  return {
    endpoint,
    urls: buildToolTestEndpointUrls({
      invokeCapability: endpoint.invokeCapability,
      specCapability: endpoint.specCapability,
    }),
  };
}

export async function getToolTestEndpointFixture(params: {
  tenantId: string;
  projectId: string;
  projectToolId: string;
}): Promise<ToolTestEndpointFixture | null> {
  await ensureDb();

  const endpoint = (await ToolTestEndpoint.findOne({
    tenantId: params.tenantId,
    projectId: params.projectId,
    projectToolId: params.projectToolId,
  }).lean()) as IToolTestEndpoint | null;

  return endpoint ? serializeToolTestEndpointFixture(endpoint) : null;
}

export async function updateToolTestEndpointFixture(
  input: UpdateToolTestEndpointFixtureInput,
): Promise<ToolTestEndpointFixture | null> {
  await ensureDb();

  const tool = (await ProjectTool.findOne({
    _id: input.projectToolId,
    tenantId: input.tenantId,
    projectId: input.projectId,
  })
    .select('_id tenantId projectId name description dslContent')
    .lean()) as LoadedProjectTool | null;

  if (!tool) {
    return null;
  }

  const existing = (await ToolTestEndpoint.findOne({
    tenantId: input.tenantId,
    projectId: input.projectId,
    projectToolId: input.projectToolId,
  }).lean()) as IToolTestEndpoint | null;

  if (!existing && input.staticResponse === undefined) {
    throw new ToolTestEndpointInputError([
      'staticResponse is required when creating a new tool test endpoint',
    ]);
  }

  const staticResponse =
    input.staticResponse !== undefined
      ? input.staticResponse
      : (existing?.staticResponse as JsonValue);

  const result = await upsertToolTestEndpoint({
    tenantId: input.tenantId,
    projectId: input.projectId,
    projectToolId: input.projectToolId,
    toolName: tool.name,
    staticResponse,
    sampleInput:
      input.sampleInput !== undefined ? input.sampleInput : (existing?.sampleInput ?? null),
    createdBy: existing?.createdBy ?? input.actorId,
    lastEditedBy: input.actorId,
  });

  return serializeToolTestEndpointFixture(result.endpoint);
}

export async function disableToolTestEndpoint(params: {
  endpointId: string;
  tenantId: string;
  projectId: string;
  lastEditedBy: string;
}): Promise<IToolTestEndpoint | null> {
  await ensureDb();

  return (await ToolTestEndpoint.findOneAndUpdate(
    {
      _id: params.endpointId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    },
    {
      $set: {
        status: 'disabled',
        lastEditedBy: params.lastEditedBy,
      },
      $inc: { _v: 1 },
    },
    { new: true },
  ).lean()) as IToolTestEndpoint | null;
}

export async function rotateToolTestEndpointCapabilities(params: {
  endpointId: string;
  tenantId: string;
  projectId: string;
  lastEditedBy: string;
}): Promise<ToolTestEndpointUpsertResult | null> {
  await ensureDb();

  const existing = (await ToolTestEndpoint.findOne({
    _id: params.endpointId,
    tenantId: params.tenantId,
    projectId: params.projectId,
  }).lean()) as IToolTestEndpoint | null;

  if (!existing) {
    return null;
  }

  return upsertToolTestEndpoint({
    tenantId: existing.tenantId,
    projectId: existing.projectId,
    projectToolId: existing.projectToolId,
    toolName: existing.toolName,
    staticResponse: existing.staticResponse as JsonValue,
    sampleInput: existing.sampleInput,
    createdBy: existing.createdBy,
    lastEditedBy: params.lastEditedBy,
    rotateCapabilities: true,
  });
}

export async function resolveToolTestInvoke(params: {
  capability: string;
  input: JsonObject;
}): Promise<{ body: JsonValue; endpoint: IToolTestEndpoint; tool: LoadedProjectTool } | null> {
  const resolution = await findEndpointByCapability('invoke', params.capability);
  if (!resolution) {
    return null;
  }

  const validationErrors = validateInputAgainstTool(resolution.tool, params.input);
  if (validationErrors.length > 0) {
    throw new ToolTestEndpointInputError(validationErrors);
  }

  return {
    body: resolution.endpoint.staticResponse as JsonValue,
    endpoint: resolution.endpoint,
    tool: resolution.tool,
  };
}

export async function resolveToolTestOpenApi(capability: string): Promise<JsonObject | null> {
  const resolution = await findEndpointByCapability('spec', capability);
  if (!resolution) {
    return null;
  }

  return buildOpenApiDocument(resolution);
}
