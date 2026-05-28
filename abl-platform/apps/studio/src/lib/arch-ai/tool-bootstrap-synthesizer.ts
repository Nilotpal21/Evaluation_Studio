import type { HttpToolFormData, ToolFormParameter } from '@agent-platform/shared';
import { serializeToolFormToDsl } from '@agent-platform/shared';
import type { SourceArchitectureContract } from '@agent-platform/arch-ai';
import {
  generateTestInputFromDsl,
  parseDslParamMetadata,
  parseDslProperties,
  parseDslToToolForm,
  parseReturnTypeString,
  parseSignatureLine,
  type ToolReturnTypeLocal,
} from '@agent-platform/shared/tools';
import {
  extractToolSignaturesFromAgents,
  type AgentDeclaredTool,
} from '@agent-platform/project-io/import';
import type { JsonValue } from '@/lib/tool-test-endpoint-service';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;
const DEFAULT_RESPONSE_TIMESTAMP = '2026-04-21T00:00:00Z';

export type BootstrapRequestedToolType =
  | 'http'
  | 'sandbox'
  | 'mcp'
  | 'workflow'
  | 'searchai'
  | 'unknown';

export interface BootstrapToolContract {
  name: string;
  description: string;
  parameters: ToolFormParameter[];
  returnType: string;
  source: 'tool_dsl' | 'agent_contract';
}

export interface BootstrapToolDefinition {
  contract: BootstrapToolContract;
  sampleInput: Record<string, unknown>;
  staticResponse: JsonValue;
}

export interface UnsupportedBootstrapToolGap {
  name: string;
  requestedType: BootstrapRequestedToolType;
  source: 'tool_dsl' | 'agent_contract';
  reason: string;
}

export interface ToolBootstrapSynthesisResult {
  tools: BootstrapToolDefinition[];
  unsupported: UnsupportedBootstrapToolGap[];
  extractionErrors: Array<{ file: string; message: string }>;
}

type SourceContractScenarioFixture = NonNullable<
  SourceArchitectureContract['scenarioFixtures']
>[number];

type SourceFixtureMatch = {
  fixture: SourceContractScenarioFixture;
  response: SourceContractScenarioFixture['toolFixtures'][number];
};

type SchemaObject = Record<string, unknown>;

const SOURCE_ID_PATTERNS = [
  /\b[A-Z]{2,}-\d{2,}(?:-[A-Z0-9]+)?\b/,
  /\b[A-Z]{2,}_\d{2,}(?:_[A-Z0-9]+)?\b/,
  /\b(?:ORD|ORDER|INV|CASE|TICKET|CUST|SKU)[-_]?[A-Z0-9]{3,}\b/i,
];

function extractToolName(signatureSource: string): string | null {
  const firstLine = signatureSource.split('\n')[0]?.trim() ?? '';
  const match = firstLine.match(/^(\w+)\s*\(/);
  return match?.[1] ?? null;
}

function normalizeDescription(description: string | null | undefined, toolName: string): string {
  const trimmed = description?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `Bootstrapped Test API for ${toolName}`;
}

function inferRequestedTypeFromDsl(dslContent: string): BootstrapRequestedToolType {
  const props = parseDslProperties(dslContent);
  const explicitType = props.type?.trim().toLowerCase();

  switch (explicitType) {
    case 'http':
      return 'http';
    case 'mcp':
      return 'mcp';
    case 'sandbox':
    case 'lambda':
      return 'sandbox';
    case 'workflow':
      return 'workflow';
    case 'searchai':
      return 'searchai';
    default:
      break;
  }

  if (props.endpoint || props.method || props.auth || props.auth_profile || props.body_schema) {
    return 'http';
  }
  if (props.server || props.server_tool || props.transport_type) {
    return 'mcp';
  }
  if (
    props.workflow_id ||
    props.trigger_id ||
    props.workflow_version_id ||
    props.workflow_version
  ) {
    return 'workflow';
  }
  if (props.index_id || props.tenant_id) {
    return 'searchai';
  }
  if (props.runtime || /(^|\n)\s*code:\s*\|/m.test(dslContent)) {
    return 'sandbox';
  }

  return 'unknown';
}

function buildBootstrapToolContractFromHttpDsl(
  dslContent: string,
  toolNameHint?: string,
): BootstrapToolContract | null {
  const parsed = parseDslToToolForm(dslContent, 'http');

  if (parsed?.toolType === 'http') {
    return {
      name: toolNameHint ?? parsed.name,
      description: normalizeDescription(parsed.description, toolNameHint ?? parsed.name),
      parameters: parsed.parameters.map((parameter: ToolFormParameter) => ({
        ...parameter,
        description: parameter.description ?? '',
      })),
      returnType: parsed.returnType,
      source: 'tool_dsl',
    };
  }

  const name = toolNameHint ?? extractToolName(dslContent);
  if (!name) {
    return null;
  }

  const signature = parseSignatureLine(dslContent);
  const props = parseDslProperties(dslContent);
  const paramMetadata = parseDslParamMetadata(dslContent);

  return {
    name,
    description: normalizeDescription(props.description ?? null, name),
    parameters: signature.parameters.map((parameter) => {
      const metadata = paramMetadata.get(parameter.name);
      return {
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        description: metadata?.description ?? '',
        ...(metadata?.enum && metadata.enum.length > 0 ? { enumValues: metadata.enum } : {}),
        ...(metadata?.default !== undefined ? { defaultValue: metadata.default } : {}),
        ...(metadata?.schema ? { objectSchema: metadata.schema } : {}),
      };
    }),
    returnType: signature.returnType,
    source: 'tool_dsl',
  };
}

function buildBootstrapToolContractFromDeclaredTool(
  tool: AgentDeclaredTool,
): BootstrapToolContract {
  return {
    name: tool.name,
    description: normalizeDescription(tool.description, tool.name),
    parameters: tool.parameters.map((parameter: AgentDeclaredTool['parameters'][number]) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      description: `Input ${parameter.name.replace(/[_-]+/g, ' ')} for ${tool.name}.`,
    })),
    returnType: parseSignatureLine(tool.signature).returnType,
    source: 'agent_contract',
  };
}

function buildBootstrapHttpToolForm(
  contract: BootstrapToolContract,
  endpoint: string,
): HttpToolFormData {
  return {
    name: contract.name,
    toolType: 'http',
    description: contract.description,
    parameters: contract.parameters,
    returnType: contract.returnType,
    endpoint,
    method: 'POST',
    auth: 'none',
  };
}

function generateResponseString(path: string, toolName: string): string {
  if (/email/i.test(path)) return 'sample@example.com';
  if (/url/i.test(path)) return 'https://example.com';
  if (/(^|_)id$/i.test(path) || /_id$/i.test(path)) return `${toolName}_001`;
  if (/status/i.test(path)) return 'ready';
  if (/name/i.test(path)) return 'Sample Name';
  if (/date/i.test(path)) return '2026-04-21';
  if (/(time|timestamp|_at)$/i.test(path)) return DEFAULT_RESPONSE_TIMESTAMP;
  if (/currency/i.test(path)) return 'USD';
  if (/message/i.test(path)) return `${toolName} completed successfully`;
  return `${path || toolName}_value`;
}

function generateResponseValue(
  typeSpec: ToolReturnTypeLocal,
  path: string,
  toolName: string,
): JsonValue {
  if (typeSpec.type === 'array') {
    return [generateResponseValue(typeSpec.items ?? { type: 'string' }, `${path}_item`, toolName)];
  }

  if (typeSpec.type === 'object') {
    const fields = typeSpec.fields ?? {};
    if (Object.keys(fields).length === 0) {
      return {
        tool: toolName,
        status: 'ready',
      };
    }

    return Object.fromEntries(
      Object.entries(fields).map(([fieldName, fieldType]) => [
        fieldName,
        generateResponseValue(fieldType, fieldName, toolName),
      ]),
    );
  }

  switch (typeSpec.type.toLowerCase()) {
    case 'string':
      return generateResponseString(path, toolName);
    case 'number':
    case 'integer':
    case 'int':
    case 'float':
      return 1;
    case 'boolean':
    case 'bool':
      return true;
    case 'object':
      return {
        tool: toolName,
        status: 'ready',
      };
    case 'array':
      return [];
    default:
      return generateResponseString(path || toolName, toolName);
  }
}

function generateStaticResponse(contract: BootstrapToolContract): JsonValue {
  const parsedReturnType = parseReturnTypeString(contract.returnType);
  return generateResponseValue(parsedReturnType, contract.name, contract.name);
}

function parseSourceFixtureResponse(value: string): JsonValue | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^(?:\{|\[|"|-?\d|true\b|false\b|null\b)/.test(trimmed)) return undefined;

  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}

function coerceSourceFixtureResponse(
  response: string,
  typeSpec: ToolReturnTypeLocal,
  path: string,
  toolName: string,
): JsonValue {
  const parsed = parseSourceFixtureResponse(response);
  if (parsed !== undefined) return parsed;

  if (typeSpec.type === 'array') {
    return [
      coerceSourceFixtureResponse(
        response,
        typeSpec.items ?? { type: 'string' },
        `${path}_item`,
        toolName,
      ),
    ];
  }

  if (typeSpec.type === 'object') {
    const fields = typeSpec.fields ?? {};
    if (Object.keys(fields).length === 0) {
      return {
        tool: toolName,
        status: response,
      };
    }

    const generated = generateResponseValue(typeSpec, path, toolName);
    const objectResponse: Record<string, JsonValue> =
      generated && typeof generated === 'object' && !Array.isArray(generated)
        ? { ...(generated as Record<string, JsonValue>) }
        : {};
    const preferredField =
      ['status', 'state', 'result', 'message', 'outcome'].find((field) => field in fields) ??
      Object.entries(fields).find(([, fieldType]) =>
        ['string', 'text'].includes(fieldType.type.toLowerCase()),
      )?.[0];

    if (preferredField) {
      objectResponse[preferredField] = response;
      return objectResponse;
    }

    return {
      ...objectResponse,
      fixture_response: response,
    };
  }

  switch (typeSpec.type.toLowerCase()) {
    case 'number':
    case 'integer':
    case 'int':
    case 'float': {
      const numeric = Number(response);
      return Number.isFinite(numeric) ? numeric : 1;
    }
    case 'boolean':
    case 'bool':
      return /^(true|yes|1|success|ready|completed)$/i.test(response);
    case 'string':
    default:
      return response;
  }
}

function buildStaticResponseFromSourceFixture(
  contract: BootstrapToolContract,
  fixtureResponse: string,
): JsonValue {
  return coerceSourceFixtureResponse(
    fixtureResponse,
    parseReturnTypeString(contract.returnType),
    contract.name,
    contract.name,
  );
}

function buildStaticResponseFromSourceFixtures(
  contract: BootstrapToolContract,
  sourceFixtures: ReadonlyArray<SourceFixtureMatch>,
  primarySourceFixture: SourceFixtureMatch | null,
): JsonValue {
  if (sourceFixtures.length === 0) {
    return generateStaticResponse(contract);
  }

  const coerced = sourceFixtures.map((sourceFixture) =>
    buildStaticResponseFromSourceFixture(contract, sourceFixture.response.response),
  );
  const objectResponses = coerced.filter(isRecord);
  if (objectResponses.length !== coerced.length) {
    return primarySourceFixture
      ? buildStaticResponseFromSourceFixture(contract, primarySourceFixture.response.response)
      : (coerced[0] ?? generateStaticResponse(contract));
  }

  const primaryResponse = primarySourceFixture
    ? buildStaticResponseFromSourceFixture(contract, primarySourceFixture.response.response)
    : null;
  const nonPrimaryResponses = sourceFixtures
    .map((sourceFixture, index) => ({ sourceFixture, response: objectResponses[index] }))
    .filter(({ sourceFixture }) => sourceFixture !== primarySourceFixture)
    .map(({ response }) => response);

  const merged = nonPrimaryResponses.reduce<Record<string, JsonValue>>(
    (merged, response) => ({ ...merged, ...(response as Record<string, JsonValue>) }),
    {},
  );
  return isRecord(primaryResponse) ? { ...merged, ...primaryResponse } : merged;
}

function buildSampleInput(contract: BootstrapToolContract): Record<string, unknown> {
  const testForm = buildBootstrapHttpToolForm(contract, 'https://example.invalid/bootstrap');
  const generated = generateTestInputFromDsl(serializeToolFormToDsl(testForm));

  for (const parameter of contract.parameters) {
    const schemaValue = generateSchemaAwareSampleInputValue(parameter);
    if (schemaValue !== undefined) {
      generated[parameter.name] = schemaValue;
    }
  }

  return generated;
}

function findSourceFixturesForTool(
  sourceContract: SourceArchitectureContract | null | undefined,
  toolName: string,
): SourceFixtureMatch[] {
  const normalizedToolName = normalizeToolIdentifier(toolName);
  const matches: SourceFixtureMatch[] = [];
  for (const fixture of sourceContract?.scenarioFixtures ?? []) {
    for (const response of fixture.toolFixtures) {
      if (normalizeToolIdentifier(response.toolName) === normalizedToolName) {
        matches.push({ fixture, response });
      }
    }
  }
  return matches;
}

function normalizeToolIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function chooseSourceFixtureForSampleInput(
  contract: BootstrapToolContract,
  sourceFixtures: ReadonlyArray<SourceFixtureMatch>,
): SourceFixtureMatch | null {
  if (sourceFixtures.length === 0) {
    return null;
  }

  const fixtureInputKeys = buildFixtureInputKeySet(contract);
  return [...sourceFixtures].sort(
    (left, right) =>
      countMatchingSampleInputFields(right.response.sampleInput, fixtureInputKeys) -
      countMatchingSampleInputFields(left.response.sampleInput, fixtureInputKeys),
  )[0]!;
}

function buildFixtureInputKeySet(contract: BootstrapToolContract): ReadonlySet<string> {
  const keys = new Set(contract.parameters.map((parameter) => parameter.name));
  for (const parameter of contract.parameters) {
    addSchemaFieldNamesToKeySet(parseObjectSchema(parameter.objectSchema), keys, parameter.name);
  }
  return keys;
}

function addSchemaFieldNamesToKeySet(
  schema: SchemaObject | null,
  keys: Set<string>,
  pathPrefix?: string,
): void {
  if (!schema) {
    return;
  }

  if (inferSchemaType(schema, 'string').toLowerCase() === 'array') {
    addSchemaFieldNamesToKeySet(normalizeSchemaObject(schema.items), keys, pathPrefix);
    return;
  }

  const properties = getSchemaProperties(schema);
  if (!properties) {
    return;
  }

  for (const [fieldName, fieldSchemaValue] of Object.entries(properties)) {
    keys.add(fieldName);
    for (const path of buildFixtureInputPathCandidates(pathPrefix, fieldName)) {
      keys.add(path);
    }

    const fieldSchema = normalizeSchemaObject(fieldSchemaValue);
    const fieldType = inferSchemaType(fieldSchema, 'string').toLowerCase();
    if (fieldType === 'object' || fieldType === 'array') {
      addSchemaFieldNamesToKeySet(fieldSchema, keys, joinFixtureInputPath(pathPrefix, fieldName));
    }
  }
}

function countMatchingSampleInputFields(
  sampleInput: Record<string, unknown> | undefined,
  fixtureInputKeys: ReadonlySet<string>,
): number {
  return Object.keys(sampleInput ?? {}).filter((key) => fixtureInputKeys.has(key)).length;
}

function applySourceFixtureToSampleInput(
  contract: BootstrapToolContract,
  sampleInput: Record<string, unknown>,
  sourceFixture: SourceFixtureMatch,
): Record<string, unknown> {
  const fixture = sourceFixture.fixture;
  const merged = { ...sampleInput };

  for (const parameter of contract.parameters) {
    const schemaValue = generateSchemaAwareSampleInputValue(parameter, sourceFixture);
    if (schemaValue !== undefined) {
      merged[parameter.name] = mergeFixtureInputValue(merged[parameter.name], schemaValue);
    }
  }

  const consumedFixtureInputKeys = new Set<string>();
  const parameterNames = new Set(contract.parameters.map((parameter) => parameter.name));
  for (const parameter of contract.parameters) {
    const objectFixtureValue = buildObjectParameterFixtureValueFromFlatInput(
      parameter,
      sourceFixture.response.sampleInput,
      consumedFixtureInputKeys,
      parameterNames,
    );
    if (objectFixtureValue !== undefined) {
      merged[parameter.name] = mergeFixtureInputValue(merged[parameter.name], objectFixtureValue);
    }
  }

  for (const [key, value] of Object.entries(sourceFixture.response.sampleInput ?? {})) {
    if (consumedFixtureInputKeys.has(key)) {
      continue;
    }
    if (value !== undefined) {
      merged[key] = mergeFixtureInputValue(merged[key], value);
    }
  }

  for (const parameter of contract.parameters) {
    if (merged[parameter.name] !== undefined) continue;
    const inferred = inferFixtureInputValue(parameter, sourceFixture);
    if (inferred !== undefined) {
      merged[parameter.name] = inferred;
    }
  }

  const messageParameter = contract.parameters.find((parameter) =>
    /(?:message|utterance|query|question|prompt|text)$/i.test(parameter.name),
  );

  if (!messageParameter) {
    return merged;
  }

  return {
    ...merged,
    [messageParameter.name]:
      sourceFixture.response.sampleInput?.[messageParameter.name] ?? fixture.userMessage,
  };
}

function buildObjectParameterFixtureValueFromFlatInput(
  parameter: ToolFormParameter,
  sampleInput: Record<string, unknown> | undefined,
  consumedKeys: Set<string>,
  topLevelParameterNames: ReadonlySet<string>,
): unknown {
  if (!sampleInput || sampleInput[parameter.name] !== undefined) {
    return undefined;
  }

  const schema = parseObjectSchema(parameter.objectSchema);
  if (!schema) {
    return undefined;
  }

  const overlay = buildFixtureObjectOverlayFromSchema(
    schema,
    sampleInput,
    consumedKeys,
    topLevelParameterNames,
    parameter.name,
  );
  return Object.keys(overlay).length > 0 ? overlay : undefined;
}

function buildFixtureObjectOverlayFromSchema(
  schema: SchemaObject,
  sampleInput: Record<string, unknown>,
  consumedKeys: Set<string>,
  topLevelParameterNames: ReadonlySet<string>,
  pathPrefix?: string,
): Record<string, unknown> {
  const properties = getSchemaProperties(schema);
  if (!properties) {
    return {};
  }

  const overlay: Record<string, unknown> = {};
  for (const [fieldName, fieldSchemaValue] of Object.entries(properties)) {
    const pathValue = findFixtureInputValueForSchemaField(
      fieldName,
      sampleInput,
      consumedKeys,
      topLevelParameterNames,
      pathPrefix,
    );
    if (pathValue.found) {
      overlay[fieldName] = pathValue.value;
      consumedKeys.add(pathValue.key);
      continue;
    }

    const fieldSchema = normalizeSchemaObject(fieldSchemaValue);
    const fieldType = inferSchemaType(fieldSchema, 'string').toLowerCase();
    if (fieldType !== 'object' && fieldType !== 'array') {
      continue;
    }

    const nestedSchema =
      fieldType === 'array' ? normalizeSchemaObject(fieldSchema.items) : fieldSchema;
    const nestedOverlay = buildFixtureObjectOverlayFromSchema(
      nestedSchema,
      sampleInput,
      consumedKeys,
      topLevelParameterNames,
      joinFixtureInputPath(pathPrefix, fieldName),
    );
    if (Object.keys(nestedOverlay).length > 0) {
      overlay[fieldName] = fieldType === 'array' ? [nestedOverlay] : nestedOverlay;
    }
  }

  return overlay;
}

function findFixtureInputValueForSchemaField(
  fieldName: string,
  sampleInput: Record<string, unknown>,
  consumedKeys: ReadonlySet<string>,
  topLevelParameterNames: ReadonlySet<string>,
  pathPrefix?: string,
): { found: true; key: string; value: unknown } | { found: false } {
  for (const path of buildFixtureInputPathCandidates(pathPrefix, fieldName)) {
    if (sampleInput[path] !== undefined && !consumedKeys.has(path)) {
      return { found: true, key: path, value: sampleInput[path] };
    }
  }

  if (
    sampleInput[fieldName] !== undefined &&
    !consumedKeys.has(fieldName) &&
    !topLevelParameterNames.has(fieldName)
  ) {
    return { found: true, key: fieldName, value: sampleInput[fieldName] };
  }

  return { found: false };
}

function buildFixtureInputPathCandidates(
  pathPrefix: string | undefined,
  fieldName: string,
): string[] {
  if (!pathPrefix) {
    return [];
  }

  const directPath = `${pathPrefix}.${fieldName}`;
  const arrayPath = `${pathPrefix}[].${fieldName}`;
  const candidates = [directPath, arrayPath];
  const relativePrefix = pathPrefix.split('.').at(-1);
  if (relativePrefix && relativePrefix !== pathPrefix) {
    candidates.push(`${relativePrefix}.${fieldName}`, `${relativePrefix}[].${fieldName}`);
  }

  return [...new Set(candidates)];
}

function joinFixtureInputPath(pathPrefix: string | undefined, fieldName: string): string {
  return pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
}

function generateSchemaAwareSampleInputValue(
  parameter: ToolFormParameter,
  sourceFixture?: SourceFixtureMatch,
): unknown {
  const schema = parseObjectSchema(parameter.objectSchema);
  if (!schema) return undefined;

  return generateSampleValueFromSchema(schema, parameter.type, parameter.name, sourceFixture);
}

function parseObjectSchema(value: string | undefined): SchemaObject | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function generateSampleValueFromSchema(
  schema: SchemaObject,
  fallbackType: string,
  path: string,
  sourceFixture?: SourceFixtureMatch,
): unknown {
  const type = typeof schema.type === 'string' ? schema.type : fallbackType;
  const normalizedType = type.toLowerCase();

  if (normalizedType === 'object') {
    const properties = getSchemaProperties(schema);
    if (!properties) return {};

    return Object.fromEntries(
      Object.entries(properties).map(([fieldName, fieldSchema]) => {
        const childPath = path ? `${path}.${fieldName}` : fieldName;
        return [
          fieldName,
          generateSampleValueFromSchema(
            normalizeSchemaObject(fieldSchema),
            inferSchemaType(fieldSchema, 'string'),
            childPath,
            sourceFixture,
          ),
        ];
      }),
    );
  }

  if (normalizedType === 'array' || normalizedType.endsWith('[]')) {
    const itemSchema = normalizeSchemaObject(
      schema.items ?? (normalizedType.endsWith('[]') ? { type: normalizedType.slice(0, -2) } : {}),
    );
    return [
      generateSampleValueFromSchema(
        itemSchema,
        inferSchemaType(itemSchema, 'string'),
        `${path}[]`,
        sourceFixture,
      ),
    ];
  }

  const enumValues = normalizeEnumValues(schema.enum);
  const defaultValue = schema.default;
  if (defaultValue !== undefined) {
    return coerceSampleInputValue(defaultValue, normalizedType);
  }

  if (sourceFixture) {
    const inferred = inferFixtureInputValue(
      {
        name: lastPathSegment(path),
        type,
        required: true,
        description: '',
        ...(enumValues.length > 0 ? { enumValues } : {}),
      },
      sourceFixture,
    );
    if (inferred !== undefined) return inferred;
  }

  if (enumValues.length > 0) return enumValues[0];

  switch (normalizedType) {
    case 'number':
    case 'integer':
    case 'int':
    case 'float':
      return 0;
    case 'boolean':
    case 'bool':
      return true;
    case 'string':
    case 'text':
    default:
      return generateSampleInputString(lastPathSegment(path));
  }
}

function normalizeSchemaObject(value: unknown): SchemaObject {
  return isRecord(value) ? value : { type: 'string' };
}

function inferSchemaType(value: unknown, fallbackType: string): string {
  return isRecord(value) && typeof value.type === 'string' ? value.type : fallbackType;
}

function getSchemaProperties(schema: SchemaObject): Record<string, unknown> | null {
  if (isRecord(schema.properties)) {
    return schema.properties;
  }

  const fieldEntries = Object.entries(schema).filter(
    ([key]) => !['type', 'description', 'required', 'default', 'enum', 'items'].includes(key),
  );
  return fieldEntries.length > 0 ? Object.fromEntries(fieldEntries) : null;
}

function normalizeEnumValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function coerceSampleInputValue(value: unknown, type: string): unknown {
  if (typeof value !== 'string') return value;
  if (['number', 'integer', 'int', 'float'].includes(type)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  if (['boolean', 'bool'].includes(type)) {
    return value.toLowerCase() === 'true';
  }
  return value;
}

function generateSampleInputString(name: string): string {
  if (/email/i.test(name)) return 'test@example.com';
  if (/phone|mobile|sms/i.test(name)) return '+1-555-000-1234';
  if (/date/i.test(name)) return '2026-01-15';
  if (/url/i.test(name)) return 'https://example.com';
  if (/name/i.test(name)) return 'Test User';
  if (/address/i.test(name)) return '123 Main St';
  if (/city/i.test(name)) return 'San Francisco';
  if (/country/i.test(name)) return 'US';
  if (/zip|postal/i.test(name)) return '94105';
  if (/(^|_)(id|number)$|_id$/i.test(name)) return 'test-id-001';
  if (/query|search/i.test(name)) return 'test query';
  if (/message|utterance|question|prompt|text|body|content/i.test(name)) {
    return 'Hello, this is a test message.';
  }
  if (/currency/i.test(name)) return 'USD';
  if (/status/i.test(name)) return 'active';
  return 'test-value';
}

function lastPathSegment(path: string): string {
  return (
    path
      .split(/[.[\]]+/)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

function mergeFixtureInputValue(existing: unknown, incoming: unknown): unknown {
  if (isRecord(existing) && isRecord(incoming)) {
    return mergeFixtureInputRecords(existing, incoming);
  }
  return incoming;
}

function mergeFixtureInputRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      merged[key] = mergeFixtureInputValue(merged[key], value);
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inferFixtureInputValue(
  parameter: ToolFormParameter,
  sourceFixture: SourceFixtureMatch,
): unknown {
  const text = [
    sourceFixture.fixture.userMessage,
    sourceFixture.fixture.expectedOutcome ?? '',
    sourceFixture.response.response,
  ]
    .join(' ')
    .trim();
  if (!text) return undefined;

  const enumValue = inferEnumFixtureValue(parameter, text);
  if (enumValue !== undefined) return enumValue;

  const lowerName = parameter.name.toLowerCase();
  if (/email/.test(lowerName)) {
    return text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  }
  if (/(phone|mobile|sms)/.test(lowerName)) {
    return text.match(/\+?\d[\d .()-]{7,}\d/)?.[0]?.replace(/\s+/g, '');
  }
  if (/(amount|price|total|credit|refund)/.test(lowerName)) {
    const amount = inferAmountFixtureValue(parameter.name, text);
    if (amount !== undefined) {
      const numeric = Number(amount);
      return /string/i.test(parameter.type) || !Number.isFinite(numeric) ? amount : numeric;
    }
  }
  if (/(date|delivery|eta)/.test(lowerName)) {
    return (
      text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ??
      text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/i)?.[0]
    );
  }
  if (
    /(^|_)(id|number)$/.test(lowerName) ||
    /(_id|sku|order|invoice|case|ticket)/.test(lowerName)
  ) {
    return inferIdentifierFixtureValue(parameter.name, text);
  }

  return undefined;
}

function inferAmountFixtureValue(parameterName: string, text: string): string | undefined {
  const lowerName = parameterName.toLowerCase();
  const labelPattern = lowerName
    .replace(/[_-]+/g, '[\\s_-]*')
    .replace(/amount|total|price|credit|refund/g, '(?:amount|total|price|credit|refund)');
  const labeled = text.match(
    new RegExp(`${labelPattern}\\s*(?:is|=|:)?\\s*\\$?(\\d+(?:\\.\\d{2})?)`, 'i'),
  )?.[1];
  if (labeled) return labeled;

  const currency = text.match(/\$\s*(\d+(?:\.\d{2})?)/)?.[1];
  if (currency) return currency;

  const semantic = text.match(
    /\b(?:amount|total|price|credit|refund)\s*(?:is|=|:)?\s*\$?(\d+(?:\.\d{2})?)\b/i,
  )?.[1];
  if (semantic) return semantic;

  return text.match(/\b\d+(?:\.\d{2})?\b/)?.[0];
}

function inferEnumFixtureValue(parameter: ToolFormParameter, text: string): string | undefined {
  for (const enumValue of parameter.enumValues ?? []) {
    const normalizedEnum = enumValue.replace(/[_-]+/g, ' ').toLowerCase();
    const normalizedText = text.replace(/[_-]+/g, ' ').toLowerCase();
    if (normalizedText.includes(normalizedEnum)) return enumValue;
  }
  return undefined;
}

function inferIdentifierFixtureValue(parameterName: string, text: string): string | undefined {
  const semanticMatch = findSemanticIdentifierMatch(parameterName, text);
  if (semanticMatch) return semanticMatch;

  const label = parameterName.replace(/[_-]+/g, '[\\s_-]*');
  const labeledMatch = text.match(
    new RegExp(`${label}\\s*(?:is|=|:|#)?\\s*([A-Z0-9][A-Z0-9_-]{2,})`, 'i'),
  );
  if (labeledMatch?.[1]) return labeledMatch[1];

  for (const pattern of SOURCE_ID_PATTERNS) {
    const match = text.match(pattern)?.[0];
    if (match) return match;
  }
  return undefined;
}

function findSemanticIdentifierMatch(parameterName: string, text: string): string | undefined {
  const lowerName = parameterName.toLowerCase();
  const semanticPatterns: Array<{ name: RegExp; value: RegExp }> = [
    {
      name: /customer|account/,
      value:
        /\b(?:customer|account|member)\s*(?:id|number)?\s*(?:is|=|:|#)?\s*(CUST[-_A-Z0-9]{3,})\b/i,
    },
    {
      name: /order/,
      value:
        /\border\s*(?:id|number)?\s*(?:is|=|:|#)?\s*([A-Z]{2,}[-_]\d{2,}(?:[-_][A-Z0-9]+)?)\b/i,
    },
    {
      name: /sku|replacement/,
      value: /\b(?:sku|item|replacement)\s*(?:id|number)?\s*(?:is|=|:|#)?\s*(SKU[-_A-Z0-9]{2,})\b/i,
    },
    {
      name: /ticket|case/,
      value:
        /\b(?:ticket|case)\s*(?:id|number)?\s*(?:is|=|:|#)?\s*((?:TICKET|CASE)[-_A-Z0-9]{3,})\b/i,
    },
    {
      name: /invoice/,
      value: /\binvoice\s*(?:id|number)?\s*(?:is|=|:|#)?\s*((?:INV|INVOICE)[-_A-Z0-9]{3,})\b/i,
    },
  ];

  for (const pattern of semanticPatterns) {
    if (!pattern.name.test(lowerName)) continue;
    const match = text.match(pattern.value)?.[1];
    if (match) return match;
  }

  return undefined;
}

function toBootstrapToolDefinition(
  contract: BootstrapToolContract,
  sourceContract?: SourceArchitectureContract | null,
): BootstrapToolDefinition {
  const sourceFixtures = findSourceFixturesForTool(sourceContract, contract.name);
  const sourceFixture = chooseSourceFixtureForSampleInput(contract, sourceFixtures);
  const sampleInput = buildSampleInput(contract);

  return {
    contract,
    sampleInput: sourceFixture
      ? applySourceFixtureToSampleInput(contract, sampleInput, sourceFixture)
      : sampleInput,
    staticResponse: buildStaticResponseFromSourceFixtures(contract, sourceFixtures, sourceFixture),
  };
}

function buildUnsupportedReason(
  toolName: string,
  requestedType: BootstrapRequestedToolType,
): string {
  if (requestedType === 'unknown') {
    return `Tool "${toolName}" did not declare an HTTP binding that onboarding can bootstrap.`;
  }

  return `Tool "${toolName}" requested ${requestedType} binding, but onboarding currently bootstraps only HTTP project tools.`;
}

export function synthesizeOnboardingBootstrapTools(input: {
  toolDsls?: Record<string, string> | null;
  agentFiles: Record<string, { path?: string; content: string }>;
  sourceContract?: SourceArchitectureContract | null;
}): ToolBootstrapSynthesisResult {
  const tools: BootstrapToolDefinition[] = [];
  const unsupported: UnsupportedBootstrapToolGap[] = [];
  const bootstrappedExplicitToolNames = new Set<string>();

  for (const [toolName, dslContent] of Object.entries(input.toolDsls ?? {})) {
    const requestedType = inferRequestedTypeFromDsl(dslContent);

    if (requestedType !== 'http') {
      unsupported.push({
        name: toolName,
        requestedType,
        source: 'tool_dsl',
        reason: buildUnsupportedReason(toolName, requestedType),
      });
      continue;
    }

    if (!TOOL_NAME_PATTERN.test(toolName)) {
      unsupported.push({
        name: toolName,
        requestedType: 'http',
        source: 'tool_dsl',
        reason: `Tool "${toolName}" is not a valid project tool name for onboarding bootstrap.`,
      });
      continue;
    }

    const contract = buildBootstrapToolContractFromHttpDsl(dslContent, toolName);
    if (!contract) {
      unsupported.push({
        name: toolName,
        requestedType: 'http',
        source: 'tool_dsl',
        reason: `Tool "${toolName}" could not be parsed into a bootstrap-ready HTTP contract.`,
      });
      continue;
    }

    tools.push(toBootstrapToolDefinition(contract, input.sourceContract));
    bootstrappedExplicitToolNames.add(toolName);
  }

  const agentFileMap = new Map<string, string>(
    Object.entries(input.agentFiles).map(([key, file]) => [file.path ?? key, file.content]),
  );
  const extracted = extractToolSignaturesFromAgents(agentFileMap);

  for (const declaredTool of extracted.tools) {
    if (bootstrappedExplicitToolNames.has(declaredTool.name)) {
      continue;
    }
    if (!TOOL_NAME_PATTERN.test(declaredTool.name)) {
      unsupported.push({
        name: declaredTool.name,
        requestedType: 'unknown',
        source: 'agent_contract',
        reason: `Tool "${declaredTool.name}" is not a valid project tool name for onboarding bootstrap.`,
      });
      continue;
    }

    tools.push(
      toBootstrapToolDefinition(
        buildBootstrapToolContractFromDeclaredTool(declaredTool),
        input.sourceContract,
      ),
    );
  }

  const bootstrappedToolNames = new Set(tools.map((tool) => tool.contract.name));

  return {
    tools,
    unsupported: unsupported.filter((gap) => !bootstrappedToolNames.has(gap.name)),
    extractionErrors: extracted.errors,
  };
}

export { buildBootstrapHttpToolForm };
