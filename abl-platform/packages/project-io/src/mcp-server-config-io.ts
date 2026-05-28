import { z } from 'zod';
import { sanitizeName } from './export/layer-assemblers/assembler-utils.js';

export const MCP_SERVER_CONFIG_AUTH_TYPES = [
  'none',
  'bearer',
  'api_key',
  'custom_headers',
  'oauth2_client_credentials',
] as const;

export const MCP_SERVER_CONFIG_CONNECTION_STATUSES = ['connected', 'failed', 'untested'] as const;

export const MCP_SERVER_CONFIG_EXPORT_SELECT =
  'name description transport url authType priority tags connectionTimeoutMs requestTimeoutMs autoReconnect maxReconnectAttempts lastConnectionStatus';

export const MCP_SERVER_CONFIG_FILE_PATH_PATTERN = /^core\/mcp-servers\/[^/]+\.mcp-config\.json$/;

export interface ProjectIOMcpServerConfig extends Record<string, unknown> {
  name: string;
  description: string | null;
  transport: 'http' | 'sse';
  url: string | null;
  authType: (typeof MCP_SERVER_CONFIG_AUTH_TYPES)[number];
  priority: number;
  tags: string | null;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  lastConnectionStatus: (typeof MCP_SERVER_CONFIG_CONNECTION_STATUSES)[number] | null;
}

export const projectIOMcpServerConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(500).nullable().optional(),
    transport: z.enum(['http', 'sse']),
    url: z.string().trim().min(1).max(2048).nullable().optional(),
    authType: z.enum(MCP_SERVER_CONFIG_AUTH_TYPES).optional(),
    priority: z.number().int().optional(),
    tags: z.string().nullable().optional(),
    connectionTimeoutMs: z.number().int().min(0).optional(),
    requestTimeoutMs: z.number().int().min(0).optional(),
    autoReconnect: z.boolean().optional(),
    maxReconnectAttempts: z.number().int().min(0).optional(),
    lastConnectionStatus: z.enum(MCP_SERVER_CONFIG_CONNECTION_STATUSES).nullable().optional(),
  })
  .strip();

type ProjectIOMcpServerConfigInput = z.input<typeof projectIOMcpServerConfigSchema>;

export function normalizeMcpServerConfigForIO(
  input: ProjectIOMcpServerConfigInput,
): ProjectIOMcpServerConfig {
  return {
    name: input.name.trim(),
    description: input.description ?? null,
    transport: input.transport,
    url: input.url ?? null,
    authType: input.authType ?? 'none',
    priority: input.priority ?? 0,
    tags: input.tags ?? null,
    connectionTimeoutMs: input.connectionTimeoutMs ?? 30000,
    requestTimeoutMs: input.requestTimeoutMs ?? 30000,
    autoReconnect: input.autoReconnect ?? true,
    maxReconnectAttempts: input.maxReconnectAttempts ?? 3,
    lastConnectionStatus: input.lastConnectionStatus ?? null,
  };
}

function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function parseMcpServerConfigData(input: unknown):
  | {
      success: true;
      data: ProjectIOMcpServerConfig;
    }
  | {
      success: false;
      error: string;
    } {
  const parsed = projectIOMcpServerConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: formatSchemaIssues(parsed.error),
    };
  }

  return {
    success: true,
    data: normalizeMcpServerConfigForIO(parsed.data),
  };
}

export function parseMcpServerConfigFile(
  filePath: string,
  content: string,
):
  | {
      success: true;
      data: ProjectIOMcpServerConfig;
    }
  | {
      success: false;
      error: string;
    } {
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(content);
  } catch (error) {
    return {
      success: false,
      error: `${filePath}: Invalid JSON — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const parsed = parseMcpServerConfigData(parsedContent);
  if (!parsed.success) {
    return {
      success: false,
      error: `${filePath}: ${parsed.error}`,
    };
  }

  return parsed;
}

export function isMcpServerConfigFilePath(filePath: string): boolean {
  return MCP_SERVER_CONFIG_FILE_PATH_PATTERN.test(filePath);
}

export function mcpServerConfigFilePath(name: string): string {
  return `core/mcp-servers/${sanitizeName(name)}.mcp-config.json`;
}

export function serializeMcpServerConfigForComparison(
  input: ProjectIOMcpServerConfigInput,
): string {
  return JSON.stringify(normalizeMcpServerConfigForIO(input));
}

export function serializeMcpServerConfigForFile(input: ProjectIOMcpServerConfigInput): string {
  return JSON.stringify(normalizeMcpServerConfigForIO(input), null, 2);
}
