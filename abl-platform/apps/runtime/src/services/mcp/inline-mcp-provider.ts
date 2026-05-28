/**
 * Inline MCP Client Provider
 *
 * Reads MCP server config directly from tool's mcp_binding.server_config
 * (baked at compile time). Zero DB lookups. Only CPU work: AES decrypt for env vars.
 *
 * Ephemeral connections: connect → execute → disconnect per tool call.
 * No persistent connections — safe for 60-day sessions.
 */

import type { McpClientProvider, McpClient } from '@abl/compiler';
import type { ToolDefinition } from '@abl/compiler/platform/ir/schema.js';
import { MCPClient } from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';
import {
  validateUrlForSSRF,
  getDevSSRFOptions,
  type SSRFValidationOptions,
} from '@agent-platform/shared-kernel/security';
import type { ProxyResolver } from '@abl/compiler/platform/constructs/executors/proxy-resolver.js';
import { isDEKEnvelopeFormat } from '@agent-platform/shared-encryption';
import type { TenantEncryptionAADContext } from '@agent-platform/shared-encryption';
import path from 'node:path';

const log = createLogger('inline-mcp-provider');

/** Allowlist of commands permitted for stdio MCP transport */
const ALLOWED_STDIO_COMMANDS = new Set(['npx', 'node', 'python', 'python3', 'uvx', 'docker']);

/** Minimal decryptor interface — matches getOrCreateSecretDecryptor() return */
export interface InlineMcpDecryptor {
  decryptForTenant(
    encryptedData: string,
    tenantId: string,
    context?: TenantEncryptionAADContext,
  ): Promise<string>;
}

// AAD contexts matching the Mongoose encryption plugin (MCPServerConfig, collection: mcp_server_configs)
const MCP_ENV_AAD: TenantEncryptionAADContext = {
  resourceType: 'mcp_server_configs',
  fieldName: 'encryptedEnv',
};
const MCP_AUTH_AAD: TenantEncryptionAADContext = {
  resourceType: 'mcp_server_configs',
  fieldName: 'encryptedAuthConfig',
};

function isMcpAuthProfileEnabled(): boolean {
  return process.env.MCP_AUTH_PROFILE_ENABLED !== 'false';
}

type MCPAuthTlsOptions = { cert: string; key: string; ca?: string };

/**
 * MCP client provider that reads server config from the tool's mcp_binding.server_config
 * (baked into the IR at compile time). Zero DB lookups at runtime.
 * Only CPU work: AES-256-GCM decrypt for encrypted env vars (~microseconds after key cache).
 */
export class InlineMcpClientProvider implements McpClientProvider {
  /** Map from serverId → tool with inline server_config */
  private serverTools: Map<string, ToolDefinition>;
  private decryptor?: InlineMcpDecryptor;
  private tenantId: string;
  /** Optional proxy resolver for routing MCP HTTP/SSE connections through a corporate proxy */
  proxyResolver?: ProxyResolver;

  constructor(
    tools: ToolDefinition[],
    decryptor: InlineMcpDecryptor | undefined,
    tenantId: string,
  ) {
    this.decryptor = decryptor;
    this.tenantId = tenantId;
    this.serverTools = new Map();
    for (const tool of tools) {
      if (tool.tool_type === 'mcp' && tool.mcp_binding?.server_config) {
        this.serverTools.set(tool.mcp_binding.server, tool);
      }
    }
    log.debug('InlineMcpClientProvider initialized', {
      servers: [...this.serverTools.keys()],
      tenantId,
    });

    if (!this.decryptor) {
      const needsDecryptor = tools.some(
        (t) =>
          t.mcp_binding?.server_config?.encrypted_env ||
          t.mcp_binding?.server_config?.encrypted_auth_config,
      );
      if (needsDecryptor) {
        log.warn(
          'InlineMcpClientProvider: encrypted MCP fields present but no decryptor available',
          {
            affectedServers: tools
              .filter(
                (t) =>
                  t.mcp_binding?.server_config?.encrypted_env ||
                  t.mcp_binding?.server_config?.encrypted_auth_config,
              )
              .map((t) => t.mcp_binding?.server_config?.name)
              .filter(Boolean),
          },
        );
      }
    }
  }

  async getClient(serverId: string, projectId?: string): Promise<McpClient | undefined> {
    const tool = this.serverTools.get(serverId);
    const config = tool?.mcp_binding?.server_config;
    if (!config) {
      log.warn('No inline MCP server config for serverId', { serverId });
      return undefined;
    }

    // SSRF validation for network transports — block private/metadata URLs
    const ssrfOpts = getDevSSRFOptions();
    if (config.url && (config.transport === 'sse' || config.transport === 'http')) {
      const ssrfResult = validateUrlForSSRF(config.url, ssrfOpts);
      if (!ssrfResult.safe) {
        log.error('MCP server URL blocked by SSRF validator', {
          serverId,
          url: config.url,
          reason: ssrfResult.reason,
        });
        return undefined;
      }
    }

    // Command allowlist for stdio transport — prevent arbitrary command execution
    if (config.transport === 'stdio') {
      const commandBase = path.basename(config.command || '');
      if (!ALLOWED_STDIO_COMMANDS.has(commandBase)) {
        log.warn('MCP stdio transport: command not in allowlist', {
          serverId,
          command: config.command,
          allowlist: [...ALLOWED_STDIO_COMMANDS],
        });
        return undefined;
      }
    }

    // Decrypt env vars through the async tenant DEK path before expanding them into the process env.
    let env: Record<string, string> | undefined;
    if (config.encrypted_env) {
      const rawEnv = config.encrypted_env;
      const isDEKFormat = isDEKEnvelopeFormat(rawEnv);
      const isPlainJSON = rawEnv.trimStart().startsWith('{');
      log.debug('MCP env decryption attempt', {
        server: config.name,
        valueLength: rawEnv.length,
        isDEKEnvelopeFormat: isDEKFormat,
        looksLikePlainJSON: isPlainJSON,
      });
      try {
        let decryptedEnv: string;
        if (isDEKFormat && this.decryptor) {
          decryptedEnv = await this.decryptor.decryptForTenant(rawEnv, this.tenantId, MCP_ENV_AAD);
        } else if (isDEKFormat && !this.decryptor) {
          throw new Error(
            `MCP server "${config.name}" has encrypted env but no decryptor is available`,
          );
        } else if (isPlainJSON) {
          // Transitional backward compatibility for IRs compiled before the raw-loader
          // fix; current IRs should carry DEK-envelope ciphertext.
          log.warn('MCP env is plain JSON in IR — using directly (transitional backward compat)', {
            server: config.name,
          });
          decryptedEnv = rawEnv;
        } else {
          throw new Error(
            `MCP server "${config.name}" encrypted_env is neither a DEK envelope nor valid JSON`,
          );
        }
        const parsed = JSON.parse(decryptedEnv);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          env = parsed as Record<string, string>;
        } else {
          throw new Error(
            `MCP server "${config.name}" env decrypted to non-object value. Expected JSON object.`,
          );
        }
      } catch (err) {
        // Re-throw validation errors directly (already have descriptive messages)
        if (
          err instanceof Error &&
          (err.message.includes('non-object value') ||
            err.message.includes('no decryptor is available') ||
            err.message.includes('neither a DEK envelope'))
        ) {
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Failed to decrypt MCP env', {
          server: config.name,
          tenantId: this.tenantId, // tenantId in log context only, NOT in error message
          error: errMsg,
        });
        // Do NOT include tenantId in user-facing error (per CLAUDE.md error sanitization)
        throw new Error(
          `MCP server "${config.name}" env decryption failed. Check KMS configuration.`,
        );
      }
    }

    // Resolve auth headers from auth_profile_id first (new MCP auth-profile path).
    // If not present, fall back to legacy encrypted_auth_config path.
    let authHeaders: Record<string, string> | undefined;
    let authTlsOptions: MCPAuthTlsOptions | undefined;
    const mcpAuthProfileEnabled = isMcpAuthProfileEnabled();
    if (
      mcpAuthProfileEnabled &&
      typeof config.auth_profile_id === 'string' &&
      config.auth_profile_id.trim().length > 0
    ) {
      try {
        const { resolveAuthHeadersFromProfileDetailed } =
          await import('@agent-platform/shared/services/mcp-auth-resolver');
        const resolved = await resolveAuthHeadersFromProfileDetailed({
          authProfileId: config.auth_profile_id.trim(),
          tenantId: this.tenantId,
          projectId:
            typeof projectId === 'string' && projectId.trim().length > 0
              ? projectId.trim()
              : undefined,
          transport: config.transport,
        });
        authHeaders = resolved.headers;
        authTlsOptions = resolved.tlsOptions;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Failed to resolve MCP auth profile headers', {
          server: config.name,
          authProfileId: config.auth_profile_id,
          tenantId: this.tenantId,
          error: errMsg,
        });
        throw err;
      }
    } else if (
      !mcpAuthProfileEnabled &&
      typeof config.auth_profile_id === 'string' &&
      config.auth_profile_id.trim().length > 0
    ) {
      log.info('MCP auth-profile resolution disabled by feature flag', {
        server: config.name,
        authProfileId: config.auth_profile_id.trim(),
      });
    }

    // Resolve proxy for network transports
    let fetchDispatcher: unknown;
    if (
      config.url &&
      this.proxyResolver &&
      (config.transport === 'sse' || config.transport === 'http')
    ) {
      const proxyConfig = this.proxyResolver.resolve(config.url);
      if (proxyConfig) {
        fetchDispatcher = await this.createProxyDispatcher(proxyConfig, authTlsOptions);
      }
    }

    if (
      !authHeaders &&
      config.encrypted_auth_config &&
      config.auth_type &&
      config.auth_type !== 'none'
    ) {
      const rawAuthConfig = config.encrypted_auth_config;
      const isDEKFormat = isDEKEnvelopeFormat(rawAuthConfig);
      const isPlainJSON = rawAuthConfig.trimStart().startsWith('{');
      log.debug('MCP auth config decryption attempt', {
        server: config.name,
        authType: config.auth_type,
        tenantId: this.tenantId,
        valueLength: rawAuthConfig.length,
        valuePrefix: rawAuthConfig.substring(0, 40),
        isDEKEnvelopeFormat: isDEKFormat,
        looksLikePlainJSON: isPlainJSON,
      });
      try {
        let decryptedAuth: string;
        if (isDEKFormat && this.decryptor) {
          // Encrypted ciphertext — decrypt via DEK
          decryptedAuth = await this.decryptor.decryptForTenant(
            rawAuthConfig,
            this.tenantId,
            MCP_AUTH_AAD,
          );
        } else if (isDEKFormat && !this.decryptor) {
          // Guard: DEK format but no decryptor available — fail closed (D-8)
          throw new Error(
            `MCP server "${config.name}" has encrypted auth config but no decryptor is available`,
          );
        } else if (isPlainJSON) {
          // Transitional backward compatibility path for IRs that still carry
          // plain JSON auth config due to older compile/load behavior.
          log.debug(
            'MCP auth config is plain JSON in IR — using directly (transitional backward compat)',
            {
              server: config.name,
              authType: config.auth_type,
            },
          );
          decryptedAuth = rawAuthConfig;
        } else {
          throw new Error(
            `MCP auth config for server "${config.name}" is neither a DEK envelope nor valid JSON`,
          );
        }
        const authConfig = JSON.parse(decryptedAuth);
        const { resolveAuthHeaders } =
          await import('@agent-platform/shared/services/mcp-auth-resolver');
        authHeaders = await resolveAuthHeaders(
          { type: config.auth_type, ...authConfig },
          this.tenantId,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Failed to resolve MCP auth headers', {
          server: config.name,
          authType: config.auth_type,
          tenantId: this.tenantId,
          error: errMsg,
          valueLength: rawAuthConfig.length,
          valuePrefix: rawAuthConfig.substring(0, 40),
          isDEKEnvelopeFormat: isDEKFormat,
          looksLikePlainJSON: isPlainJSON,
        });
        // Re-throw guard/validation errors and decryption failures — fail closed (D-8).
        // Symmetric with the encrypted_env catch block above.
        if (
          err instanceof Error &&
          (errMsg.includes('no decryptor is available') ||
            errMsg.includes('neither a DEK envelope'))
        ) {
          throw err;
        }
        if (
          isDEKFormat &&
          (errMsg.includes('decrypt') || errMsg.includes('KMS') || errMsg.includes('DEK'))
        ) {
          throw new Error(
            `MCP server "${config.name}" auth config decryption failed. Check KMS configuration.`,
          );
        }
        // For non-decryption failures (e.g. resolveAuthHeaders network error): continue without auth
      }
    }

    return new EphemeralMcpClient(
      config,
      env,
      fetchDispatcher,
      ssrfOpts,
      authHeaders,
      authTlsOptions,
    );
  }

  /**
   * Create an undici dispatcher configured for proxy routing.
   * Uses the same dynamic import pattern as HttpToolExecutor for zero hard deps.
   */
  private async createProxyDispatcher(
    proxyConfig: {
      proxyUrl: string;
      caCertificate?: string;
      clientCert?: string;
      clientKey?: string;
    },
    tlsOptions?: MCPAuthTlsOptions,
  ): Promise<unknown> {
    try {
      // Variable indirection bypasses TS module resolution (undici types not installed)
      const mod = 'undici';
      const undici = await import(/* @vite-ignore */ mod);
      const ProxyAgentCtor = (undici as Record<string, unknown>).ProxyAgent as
        | (new (opts: Record<string, unknown>) => unknown)
        | undefined;
      if (!ProxyAgentCtor) return undefined;

      const proxyOpts: Record<string, unknown> = { uri: proxyConfig.proxyUrl };
      if (proxyConfig.caCertificate || proxyConfig.clientCert || tlsOptions) {
        const requestTls: Record<string, unknown> = {};
        if (proxyConfig.caCertificate) requestTls.ca = proxyConfig.caCertificate;
        if (proxyConfig.clientCert) requestTls.cert = proxyConfig.clientCert;
        if (proxyConfig.clientKey) requestTls.key = proxyConfig.clientKey;
        if (tlsOptions?.ca) requestTls.ca = tlsOptions.ca;
        if (tlsOptions?.cert) requestTls.cert = tlsOptions.cert;
        if (tlsOptions?.key) requestTls.key = tlsOptions.key;
        proxyOpts.requestTls = requestTls;
      }

      log.debug('MCP proxy dispatcher created', { proxyUrl: proxyConfig.proxyUrl });
      return new ProxyAgentCtor(proxyOpts);
    } catch (err) {
      log.warn('Failed to create MCP proxy dispatcher — connections will be direct', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}

/**
 * Ephemeral MCP client — connects on callTool, disconnects after.
 * No persistent connection state. Safe for long-lived sessions.
 */
class EphemeralMcpClient implements McpClient {
  constructor(
    private config: NonNullable<NonNullable<ToolDefinition['mcp_binding']>['server_config']>,
    private env?: Record<string, string>,
    private fetchDispatcher?: unknown,
    private ssrfOptions?: SSRFValidationOptions,
    private authHeaders?: Record<string, string>,
    private authTlsOptions?: MCPAuthTlsOptions,
  ) {}

  async callTool(
    toolName: string,
    params: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    // Merge static auth headers with dynamic per-call headers (dynamic takes precedence)
    const mergedHeaders =
      this.authHeaders || headers ? { ...this.authHeaders, ...headers } : undefined;

    const client = new MCPClient({
      name: this.config.name,
      transport: this.config.transport,
      command: this.config.command,
      args: this.config.args,
      env: this.env,
      url: this.config.url,
      connectionTimeoutMs: this.config.connection_timeout_ms,
      requestTimeoutMs: this.config.request_timeout_ms,
      allowedCommands: this.config.allowed_commands,
      headers: mergedHeaders,
      fetchDispatcher: this.fetchDispatcher,
      tlsOptions: this.authTlsOptions,
      ssrfOptions: this.ssrfOptions,
    });

    // Attach error listener before connect so async transport errors don't crash the process
    client.on('error', (err) => {
      log.error('MCP client transport error', { server: this.config.name, error: err.message });
    });

    const start = Date.now();
    try {
      await client.connect();
      const result = await client.callTool(toolName, params);

      log.debug('MCP tool call complete', {
        server: this.config.name,
        tool: toolName,
        latencyMs: Date.now() - start,
      });

      if (result.isError) {
        const errorText = result.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { type: string; text?: string }) => c.text)
          .join('\n');
        throw new Error(errorText || 'MCP tool execution failed');
      }

      // Extract text content from MCP result
      const textContent = result.content.find((c: { type: string }) => c.type === 'text');
      if (textContent && 'text' in textContent) {
        // Try to parse as JSON for structured results
        try {
          return JSON.parse(textContent.text as string);
        } catch {
          return textContent.text;
        }
      }

      return result;
    } finally {
      await client.disconnect().catch((err: unknown) => {
        log.warn('MCP disconnect failed', {
          server: this.config.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}
