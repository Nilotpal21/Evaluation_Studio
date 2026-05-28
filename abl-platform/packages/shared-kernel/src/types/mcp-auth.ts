/**
 * MCP Server Authentication Types
 *
 * Discriminated union for MCP server auth configs.
 * Used by: DB model (encrypted), API routes (validation), runtime (header resolution).
 */

export type McpAuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'api_key'; headerName: string; value: string }
  | { type: 'custom_headers'; headers: Record<string, string> }
  | {
      type: 'oauth2_client_credentials';
      clientId: string;
      clientSecret: string;
      tokenEndpoint: string;
      scope?: string;
    };

export type McpAuthType = McpAuthConfig['type'];

export const MCP_AUTH_TYPES: McpAuthType[] = [
  'none',
  'bearer',
  'api_key',
  'custom_headers',
  'oauth2_client_credentials',
];
