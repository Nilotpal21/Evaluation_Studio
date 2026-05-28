/**
 * MCP Client
 *
 * Full-featured MCP client implementation.
 * Supports:
 * - Stdio and SSE transports
 * - Tools, Resources, Prompts
 * - Sampling requests
 * - Notifications and subscriptions
 *
 * SECURITY:
 * - Command allowlist for stdio transport
 * - Env var sanitization (blocks PATH/LD_PRELOAD override)
 * - Force-kill timeout for child processes
 * - Max pending request limit
 * - Reconnect jitter to avoid thundering herd
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  MCPMethod,
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
  MCPTool,
  ToolCallParams,
  ToolCallResult,
  MCPResource,
  ResourceReadParams,
  ResourceReadResult,
  MCPPrompt,
  PromptGetParams,
  PromptGetResult,
  SamplingCreateMessageParams,
  SamplingCreateMessageResult,
  MCPLogLevel,
} from './protocol.js';
import { MCP_PROTOCOL_VERSION } from './protocol.js';
import { createLogger } from '../logger.js';
import {
  assertUrlSafeForSSRF,
  type SSRFValidationOptions,
} from '@agent-platform/shared-kernel/security';

const log = createLogger('mcp-client');

// =============================================================================
// SECURITY
// =============================================================================

/** Environment variables that must never be overridden by server config */
const BLOCKED_ENV_VARS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
]);

/**
 * Audit event emitted by MCP client operations.
 */
export interface MCPAuditEvent {
  operation: 'connect' | 'disconnect' | 'tool_call' | 'resource_read' | 'prompt_get' | 'error';
  serverName: string;
  tenantId?: string;
  toolName?: string;
  resourceUri?: string;
  timestamp: Date;
  durationMs?: number;
  success?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type MCPAuditHook = (event: MCPAuditEvent) => void | Promise<void>;

// =============================================================================
// MCP TRACE (file-based debug traces, gated by MCP_TRACE env var)
// =============================================================================

const MCP_TRACE_DIR = join(process.cwd(), 'mcp-traces');
let _mcpTraceSeq = 0;

function dumpMcpTrace(
  phase: 'request' | 'response',
  serverName: string,
  method: string,
  data: Record<string, unknown>,
): void {
  if (process.env.MCP_TRACE !== 'true') return;
  try {
    if (!existsSync(MCP_TRACE_DIR)) mkdirSync(MCP_TRACE_DIR, { recursive: true });
    const seq = String(++_mcpTraceSeq).padStart(4, '0');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeMethod = method.replace(/\//g, '_');
    const filename = `${seq}_${ts}_${safeName}_${safeMethod}_${phase}.json`;
    writeFileSync(join(MCP_TRACE_DIR, filename), JSON.stringify(data, null, 2));
    log.info(`MCP_TRACE_${phase.toUpperCase()} written`, {
      file: filename,
      server: serverName,
      method,
    });
  } catch (err) {
    log.warn('Failed to write MCP trace', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// TYPES
// =============================================================================

export type MCPTransportType = 'stdio' | 'sse' | 'http';

export interface MCPClientConfig {
  /** Server name for identification */
  name: string;

  /** Transport type */
  transport: MCPTransportType;

  /** Tenant ID for isolation */
  tenantId?: string;

  /** Command to spawn (for stdio) */
  command?: string;

  /** Command arguments (for stdio) */
  args?: string[];

  /** Environment variables (for stdio) — blocked vars are filtered */
  env?: Record<string, string>;

  /** Allowed commands (for stdio) — if set, only these commands can be spawned */
  allowedCommands?: string[];

  /** Custom headers to include in SSE/HTTP requests (e.g. auth headers) */
  headers?: Record<string, string>;

  /** SSE URL (for sse transport) */
  url?: string;

  /** Allowed URL patterns for SSE (regex strings) */
  allowedUrlPatterns?: string[];

  /** Connection timeout (ms) */
  connectionTimeoutMs?: number;

  /** Request timeout (ms) */
  requestTimeoutMs?: number;

  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;

  /** Max reconnect attempts */
  maxReconnectAttempts?: number;

  /** Max pending requests before rejecting new ones */
  maxPendingRequests?: number;

  /** Audit hook */
  auditHook?: MCPAuditHook;

  /**
   * Optional fetch dispatcher (e.g. undici.ProxyAgent) for SSE/HTTP transports.
   * Used to route MCP connections through an organization-level proxy.
   * Typed as `unknown` to avoid hard dependency on undici types.
   */
  fetchDispatcher?: unknown;

  /**
   * Optional TLS/mTLS options for direct HTTP/SSE MCP connections.
   * Used when no explicit fetchDispatcher is provided.
   */
  tlsOptions?: {
    ca?: string;
    cert?: string;
    key?: string;
    rejectUnauthorized?: boolean;
  };

  /** SSRF validation options — pass { allowLocalhost: true } for dev mode */
  ssrfOptions?: SSRFValidationOptions;
}

export interface MCPClientEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  notification: (method: string, params: unknown) => void;
  toolsChanged: () => void;
  resourcesChanged: () => void;
  promptsChanged: () => void;
  resourceUpdated: (uri: string) => void;
  log: (level: MCPLogLevel, message: string, data?: unknown) => void;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface PendingCloseErrorEnvelope {
  code: 'AUTH_REFRESH_RECONNECT' | 'AUTH_REFRESH_FAILED';
  reconnectAfterMs?: number;
  message?: string;
}

// =============================================================================
// MCP CLIENT
// =============================================================================

export class MCPClient extends EventEmitter {
  private readonly config: Required<
    Pick<
      MCPClientConfig,
      | 'name'
      | 'transport'
      | 'connectionTimeoutMs'
      | 'requestTimeoutMs'
      | 'autoReconnect'
      | 'maxReconnectAttempts'
      | 'maxPendingRequests'
    >
  > &
    MCPClientConfig;
  private transport: MCPTransport | null = null;
  private serverCapabilities: ServerCapabilities | null = null;
  private serverInfo: { name: string; version: string } | null = null;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private _tools: Map<string, MCPTool> = new Map();
  private _resources: Map<string, MCPResource> = new Map();
  private _prompts: Map<string, MCPPrompt> = new Map();
  private subscriptions: Set<string> = new Set();
  private isConnected = false;
  private reconnectAttempts = 0;
  private auditHook?: MCPAuditHook;
  private _traceMap = new Map<string | number, { method: string; startTime: number }>();
  private pendingCloseErrorEnvelope: PendingCloseErrorEnvelope | null = null;

  constructor(config: MCPClientConfig) {
    super();
    this.config = {
      connectionTimeoutMs: 30000,
      requestTimeoutMs: 60000,
      autoReconnect: true,
      maxReconnectAttempts: 3,
      maxPendingRequests: 100,
      ...config,
    };
    this.auditHook = config.auditHook;
  }

  // ===========================================================================
  // CONNECTION LIFECYCLE
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    log.info('Connecting to MCP server', { name: this.config.name });

    try {
      // Create transport
      this.transport = await this.createTransport();
      this.transport.on('message', (msg) => this.handleMessage(msg));
      this.transport.on('error', (err) => this.handleTransportError(err));
      this.transport.on('close', () => this.handleTransportClose());

      // Initialize connection
      const initResult = await this.initialize();
      this.serverCapabilities = initResult.capabilities;
      this.serverInfo = initResult.serverInfo;

      // Send initialized notification
      await this.notify('initialized', {});

      // Fetch initial data
      await this.refreshTools();
      await this.refreshResources();
      await this.refreshPrompts();

      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected');

      this.emitAudit({
        operation: 'connect',
        serverName: this.config.name,
        timestamp: new Date(),
        success: true,
      });

      log.info('Connected to MCP server', {
        name: this.config.name,
        serverName: this.serverInfo.name,
        serverVersion: this.serverInfo.version,
        toolCount: this._tools.size,
        resourceCount: this._resources.size,
        promptCount: this._prompts.size,
      });
    } catch (error) {
      this.emitAudit({
        operation: 'connect',
        serverName: this.config.name,
        timestamp: new Date(),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      log.error('Failed to connect to MCP server', {
        name: this.config.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    log.info('Disconnecting from MCP server', { name: this.config.name });

    try {
      // Unsubscribe from all resources
      for (const uri of this.subscriptions) {
        await this.unsubscribeResource(uri).catch((err) =>
          log.warn('Failed to unsubscribe resource during disconnect', {
            name: this.config.name,
            uri,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      // Send shutdown
      await this.request('shutdown', {}).catch((err) =>
        log.warn('Failed to send shutdown request during disconnect', {
          name: this.config.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      // Close transport
      this.transport?.close();
    } finally {
      this.cleanup();
      this.emitAudit({
        operation: 'disconnect',
        serverName: this.config.name,
        timestamp: new Date(),
        success: true,
      });
      this.emit('disconnected', 'client_initiated');
    }
  }

  private async initialize(): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        sampling: {},
        roots: { listChanged: true },
      },
      clientInfo: {
        name: 'abl-runtime',
        version: '1.0.0',
      },
    };

    return this.request('initialize', params) as Promise<InitializeResult>;
  }

  setPendingCloseErrorEnvelope(envelope: PendingCloseErrorEnvelope): void {
    this.pendingCloseErrorEnvelope = envelope;
  }

  private buildPendingCloseError(): Error {
    if (!this.pendingCloseErrorEnvelope) {
      return new Error('Connection closed');
    }

    const reconnectAfterMs =
      typeof this.pendingCloseErrorEnvelope.reconnectAfterMs === 'number' &&
      Number.isFinite(this.pendingCloseErrorEnvelope.reconnectAfterMs)
        ? this.pendingCloseErrorEnvelope.reconnectAfterMs
        : undefined;

    const message =
      this.pendingCloseErrorEnvelope.message ??
      (this.pendingCloseErrorEnvelope.code === 'AUTH_REFRESH_RECONNECT'
        ? 'MCP auth refresh in progress; reconnect and retry this tool call.'
        : 'MCP auth refresh failed.');

    return new Error(
      JSON.stringify({
        code: this.pendingCloseErrorEnvelope.code,
        ...(reconnectAfterMs !== undefined ? { reconnectAfterMs } : {}),
        message,
      }),
    );
  }

  private cleanup(): void {
    this.isConnected = false;
    this.transport = null;
    this.serverCapabilities = null;
    this.serverInfo = null;

    const pendingCloseError = this.buildPendingCloseError();

    // Cancel pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(pendingCloseError);
    }
    this.pendingRequests.clear();
    this.pendingCloseErrorEnvelope = null;
    this._traceMap.clear();

    this._tools.clear();
    this._resources.clear();
    this._prompts.clear();
    this.subscriptions.clear();
  }

  // ===========================================================================
  // TOOLS
  // ===========================================================================

  async listTools(): Promise<MCPTool[]> {
    return Array.from(this._tools.values());
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult> {
    const params: ToolCallParams = {
      name,
      arguments: args,
    };

    const startTime = Date.now();
    try {
      const result = (await this.request('tools/call', params)) as ToolCallResult;
      this.emitAudit({
        operation: 'tool_call',
        serverName: this.config.name,
        tenantId: this.config.tenantId,
        toolName: name,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        success: !result.isError,
      });
      return result;
    } catch (error) {
      this.emitAudit({
        operation: 'tool_call',
        serverName: this.config.name,
        tenantId: this.config.tenantId,
        toolName: name,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async refreshTools(): Promise<void> {
    if (!this.serverCapabilities?.tools) {
      return;
    }

    const result = (await this.request('tools/list', {})) as { tools: MCPTool[] };
    this._tools.clear();
    for (const tool of result.tools) {
      this._tools.set(tool.name, tool);
    }
  }

  // ===========================================================================
  // RESOURCES
  // ===========================================================================

  async listResources(): Promise<MCPResource[]> {
    return Array.from(this._resources.values());
  }

  async readResource(uri: string): Promise<ResourceReadResult> {
    const params: ResourceReadParams = { uri };
    const startTime = Date.now();
    try {
      const result = (await this.request('resources/read', params)) as ResourceReadResult;
      this.emitAudit({
        operation: 'resource_read',
        serverName: this.config.name,
        tenantId: this.config.tenantId,
        resourceUri: uri,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        success: true,
      });
      return result;
    } catch (error) {
      this.emitAudit({
        operation: 'resource_read',
        serverName: this.config.name,
        tenantId: this.config.tenantId,
        resourceUri: uri,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw error;
    }
  }

  async subscribeResource(uri: string): Promise<void> {
    if (!this.serverCapabilities?.resources?.subscribe) {
      throw new Error('Server does not support resource subscriptions');
    }

    await this.request('resources/subscribe', { uri });
    this.subscriptions.add(uri);
  }

  async unsubscribeResource(uri: string): Promise<void> {
    await this.request('resources/unsubscribe', { uri });
    this.subscriptions.delete(uri);
  }

  async refreshResources(): Promise<void> {
    if (!this.serverCapabilities?.resources) {
      return;
    }

    const result = (await this.request('resources/list', {})) as { resources: MCPResource[] };
    this._resources.clear();
    for (const resource of result.resources) {
      this._resources.set(resource.uri, resource);
    }
  }

  // ===========================================================================
  // PROMPTS
  // ===========================================================================

  async listPrompts(): Promise<MCPPrompt[]> {
    return Array.from(this._prompts.values());
  }

  async fetchPrompt(name: string, args?: Record<string, string>): Promise<PromptGetResult> {
    const params: PromptGetParams = { name, arguments: args };
    const startTime = Date.now();
    try {
      const result = (await this.request('prompts/get', params)) as PromptGetResult;
      this.emitAudit({
        operation: 'prompt_get',
        serverName: this.config.name,
        tenantId: this.config.tenantId,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        success: true,
        metadata: { promptName: name },
      });
      return result;
    } catch (error) {
      this.emitAudit({
        operation: 'prompt_get',
        serverName: this.config.name,
        tenantId: this.config.tenantId,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw error;
    }
  }

  async refreshPrompts(): Promise<void> {
    if (!this.serverCapabilities?.prompts) {
      return;
    }

    const result = (await this.request('prompts/list', {})) as { prompts: MCPPrompt[] };
    this._prompts.clear();
    for (const prompt of result.prompts) {
      this._prompts.set(prompt.name, prompt);
    }
  }

  // ===========================================================================
  // SAMPLING
  // ===========================================================================

  async createSamplingMessage(
    params: SamplingCreateMessageParams,
  ): Promise<SamplingCreateMessageResult> {
    return this.request('sampling/createMessage', params) as Promise<SamplingCreateMessageResult>;
  }

  // ===========================================================================
  // GETTERS
  // ===========================================================================

  get connected(): boolean {
    return this.isConnected;
  }

  get capabilities(): ServerCapabilities | null {
    return this.serverCapabilities;
  }

  get server(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  get toolCount(): number {
    return this._tools.size;
  }

  get resourceCount(): number {
    return this._resources.size;
  }

  get promptCount(): number {
    return this._prompts.size;
  }

  getTool(name: string): MCPTool | undefined {
    return this._tools.get(name);
  }

  getResource(uri: string): MCPResource | undefined {
    return this._resources.get(uri);
  }

  getPrompt(name: string): MCPPrompt | undefined {
    return this._prompts.get(name);
  }

  // ===========================================================================
  // TRANSPORT
  // ===========================================================================

  private async createTransport(): Promise<MCPTransport> {
    if (this.config.transport === 'stdio') {
      return this.createStdioTransport();
    } else if (this.config.transport === 'sse') {
      return this.createSSETransport();
    } else if (this.config.transport === 'http') {
      return this.createStreamableHTTPTransport();
    } else {
      throw new Error(`Unsupported transport: ${this.config.transport}`);
    }
  }

  private async createStdioTransport(): Promise<MCPTransport> {
    const { spawn } = await import('child_process');

    if (!this.config.command) {
      throw new Error('Command is required for stdio transport');
    }

    // Security: validate command against allowlist
    if (this.config.allowedCommands && this.config.allowedCommands.length > 0) {
      const commandBase = this.config.command.split('/').pop() || this.config.command;
      if (
        !this.config.allowedCommands.includes(commandBase) &&
        !this.config.allowedCommands.includes(this.config.command)
      ) {
        throw new Error(`Command "${this.config.command}" is not in the allowed commands list`);
      }
    }

    // Security: sanitize env vars — block dangerous overrides
    const safeEnv = { ...process.env };
    if (this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        if (BLOCKED_ENV_VARS.has(key)) {
          log.warn('Blocked env var override', { name: this.config.name, var: key });
          continue;
        }
        safeEnv[key] = value;
      }
    }

    const child = spawn(this.config.command, this.config.args || [], {
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new StdioTransport(child);
  }

  private async createSSETransport(): Promise<MCPTransport> {
    if (!this.config.url) {
      throw new Error('URL is required for SSE transport');
    }

    // Security: validate URL against allowed patterns
    if (this.config.allowedUrlPatterns && this.config.allowedUrlPatterns.length > 0) {
      const allowed = this.config.allowedUrlPatterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(this.config.url!);
        } catch {
          return false;
        }
      });
      if (!allowed) {
        throw new Error(`URL "${this.config.url}" does not match any allowed URL pattern`);
      }
    }

    // Security: SSRF protection — blocks private IPs, cloud metadata endpoints
    assertUrlSafeForSSRF(this.config.url, this.config.ssrfOptions ?? { allowLocalhost: false });
    const fetchDispatcher = await this.resolveNetworkDispatcher();

    const transport = new SSETransport(
      this.config.url,
      fetchDispatcher,
      this.config.ssrfOptions,
      this.config.headers,
    );
    await transport.connect(this.config.connectionTimeoutMs);
    return transport;
  }

  private async createStreamableHTTPTransport(): Promise<MCPTransport> {
    if (!this.config.url) {
      throw new Error('URL is required for HTTP transport');
    }

    // Security: validate URL against allowed patterns
    if (this.config.allowedUrlPatterns && this.config.allowedUrlPatterns.length > 0) {
      const allowed = this.config.allowedUrlPatterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(this.config.url!);
        } catch {
          return false;
        }
      });
      if (!allowed) {
        throw new Error(`URL "${this.config.url}" does not match any allowed URL pattern`);
      }
    }

    // Security: SSRF protection — blocks private IPs, cloud metadata endpoints
    assertUrlSafeForSSRF(this.config.url, this.config.ssrfOptions ?? { allowLocalhost: false });
    const fetchDispatcher = await this.resolveNetworkDispatcher();

    return new StreamableHTTPTransport(this.config.url, fetchDispatcher, this.config.headers);
  }

  private async resolveNetworkDispatcher(): Promise<unknown> {
    if (this.config.fetchDispatcher) {
      return this.config.fetchDispatcher;
    }

    const tlsOptions = this.config.tlsOptions;
    if (!tlsOptions) {
      return undefined;
    }

    const connect: Record<string, unknown> = {};
    if (typeof tlsOptions.ca === 'string' && tlsOptions.ca.length > 0) {
      connect.ca = tlsOptions.ca;
    }
    if (typeof tlsOptions.cert === 'string' && tlsOptions.cert.length > 0) {
      connect.cert = tlsOptions.cert;
    }
    if (typeof tlsOptions.key === 'string' && tlsOptions.key.length > 0) {
      connect.key = tlsOptions.key;
    }
    if (typeof tlsOptions.rejectUnauthorized === 'boolean') {
      connect.rejectUnauthorized = tlsOptions.rejectUnauthorized;
    }

    if (Object.keys(connect).length === 0) {
      return undefined;
    }

    try {
      const mod = 'undici';
      const undici = await import(/* @vite-ignore */ mod);
      const AgentCtor = (undici as Record<string, unknown>).Agent as
        | (new (opts: Record<string, unknown>) => unknown)
        | undefined;
      if (!AgentCtor) {
        throw new Error('undici Agent constructor unavailable');
      }

      return new AgentCtor({ connect });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to create MCP mTLS dispatcher', {
        server: this.config.name,
        error: message,
      });
      throw new Error(`mTLS transport is unavailable for MCP server "${this.config.name}"`);
    }
  }

  // ===========================================================================
  // MESSAGE HANDLING
  // ===========================================================================

  private async request(method: MCPMethod, params: unknown): Promise<unknown> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    // Enforce max pending requests
    if (this.pendingRequests.size >= this.config.maxPendingRequests) {
      throw new Error(`Max pending requests (${this.config.maxPendingRequests}) exceeded`);
    }

    const id = randomUUID();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const startTime = Date.now();
    this._traceMap.set(id, { method, startTime });
    dumpMcpTrace('request', this.config.name, method, {
      server: this.config.name,
      transport: this.config.transport,
      url: this.config.url || null,
      headers: this.config.headers || {},
      jsonrpc: request,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        this._traceMap.delete(id);
        dumpMcpTrace('response', this.config.name, method, {
          server: this.config.name,
          transport: this.config.transport,
          url: this.config.url || null,
          latencyMs: Date.now() - startTime,
          timeout: true,
          error: `Request timeout: ${method}`,
        });
        reject(new Error(`Request timeout: ${method}`));
      }, this.config.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.transport!.send(request);
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.transport.send(notification);
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Response to a request
    if ('id' in message && message.id !== undefined) {
      // Trace the response before resolving/rejecting
      const traceEntry = this._traceMap.get(message.id);
      if (traceEntry) {
        this._traceMap.delete(message.id);
        dumpMcpTrace('response', this.config.name, traceEntry.method, {
          server: this.config.name,
          transport: this.config.transport,
          url: this.config.url || null,
          latencyMs: Date.now() - traceEntry.startTime,
          success: !message.error,
          jsonrpc: message,
        });
      }

      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Notification
    if ('method' in message) {
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;

    switch (method) {
      case 'notifications/tools/list_changed':
        this.refreshTools().catch((e) => log.error('Failed to refresh tools', { error: e }));
        this.emit('toolsChanged');
        break;

      case 'notifications/resources/list_changed':
        this.refreshResources().catch((e) =>
          log.error('Failed to refresh resources', { error: e }),
        );
        this.emit('resourcesChanged');
        break;

      case 'notifications/resources/updated': {
        const updateParams = params as { uri: string } | undefined;
        if (updateParams?.uri) {
          this.emit('resourceUpdated', updateParams.uri);
        }
        break;
      }

      case 'notifications/prompts/list_changed':
        this.refreshPrompts().catch((e) => log.error('Failed to refresh prompts', { error: e }));
        this.emit('promptsChanged');
        break;

      case 'notifications/message': {
        const logParams = params as { level: MCPLogLevel; logger?: string; data: unknown };
        this.emit('log', logParams.level, logParams.logger || 'server', logParams.data);
        break;
      }

      default:
        this.emit('notification', method, params);
    }
  }

  private handleTransportError(error: Error): void {
    log.error('Transport error', { name: this.config.name, error: error.message });
    this.emitAudit({
      operation: 'error',
      serverName: this.config.name,
      timestamp: new Date(),
      success: false,
      error: error.message,
    });
    // Only emit if listeners are attached — emitting 'error' with no listener crashes the process
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  private handleTransportClose(): void {
    if (!this.isConnected) return;

    log.warn('Transport closed', { name: this.config.name });
    this.cleanup();
    this.emit('disconnected', 'transport_closed');

    // Auto-reconnect with jitter
    if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      // Add 0-25% jitter to avoid thundering herd
      const jitter = Math.random() * baseDelay * 0.25;
      const delay = baseDelay + jitter;
      log.info('Scheduling reconnect', {
        name: this.config.name,
        attempt: this.reconnectAttempts,
        delayMs: Math.round(delay),
      });
      setTimeout(
        () =>
          this.connect().catch((err) =>
            log.warn('Reconnect attempt failed', {
              name: this.config.name,
              attempt: this.reconnectAttempts,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        delay,
      );
    }
  }

  // ===========================================================================
  // AUDIT HELPER
  // ===========================================================================

  private emitAudit(event: MCPAuditEvent): void {
    if (this.auditHook) {
      Promise.resolve(this.auditHook(event)).catch((err) =>
        log.warn('Audit hook failed', {
          serverName: event.serverName,
          operation: event.operation,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

// =============================================================================
// TRANSPORT INTERFACE
// =============================================================================

interface MCPTransport extends EventEmitter {
  send(message: JsonRpcRequest | JsonRpcNotification): void;
  close(): void;
}

// =============================================================================
// STDIO TRANSPORT
// =============================================================================

const FORCE_KILL_TIMEOUT_MS = 5000;

class StdioTransport extends EventEmitter implements MCPTransport {
  private child: import('child_process').ChildProcess;
  private buffer = '';

  constructor(child: import('child_process').ChildProcess) {
    super();
    this.child = child;

    child.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        log.warn('MCP server stderr', { data: msg });
      }
    });

    child.on('error', (err) => this.emit('error', err));
    child.on('close', () => this.emit('close'));
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    const data = JSON.stringify(message) + '\n';
    this.child.stdin?.write(data);
  }

  close(): void {
    this.child.kill('SIGTERM');

    // Force-kill after timeout if process doesn't exit
    const forceKillTimer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Process may have already exited
      }
    }, FORCE_KILL_TIMEOUT_MS);

    this.child.once('close', () => clearTimeout(forceKillTimer));
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.emit('message', message);
        } catch (e) {
          log.warn('Failed to parse MCP message', { line: line.substring(0, 200), error: e });
        }
      }
    }
  }
}

// =============================================================================
// SSE TRANSPORT
// =============================================================================

/**
 * MCP SSE Transport
 *
 * Implements the MCP SSE transport protocol:
 * 1. Client GETs the SSE endpoint to establish a stream
 * 2. Server sends `event: endpoint` with the POST URL for sending messages
 * 3. Client POSTs JSON-RPC messages to that endpoint URL
 * 4. Server sends `event: message` with JSON-RPC responses/notifications via SSE
 *
 * The transport must wait for the `endpoint` event before sending any messages.
 * Uses `connect()` to establish the SSE stream and resolve the endpoint URL.
 */
class SSETransport extends EventEmitter implements MCPTransport {
  private sseUrl: string;
  private postUrl: string | null = null;
  private abortController: AbortController | null = null;
  private endpointReady: Promise<void>;
  private resolveEndpoint!: () => void;
  private rejectEndpoint!: (err: Error) => void;
  private fetchDispatcher?: unknown;
  private ssrfOptions?: SSRFValidationOptions;
  private customHeaders?: Record<string, string>;

  constructor(
    url: string,
    fetchDispatcher?: unknown,
    ssrfOptions?: SSRFValidationOptions,
    headers?: Record<string, string>,
  ) {
    super();
    this.sseUrl = url;
    this.fetchDispatcher = fetchDispatcher;
    this.ssrfOptions = ssrfOptions;
    this.customHeaders = headers;
    this.endpointReady = new Promise<void>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
  }

  /** Start the SSE connection and wait for the endpoint event. */
  async connect(timeoutMs = 30000): Promise<void> {
    const timer = setTimeout(() => {
      this.rejectEndpoint(new Error('SSE endpoint handshake timeout'));
    }, timeoutMs);

    this.startSSEStream();

    try {
      await this.endpointReady;
    } finally {
      clearTimeout(timer);
    }
  }

  private startSSEStream(): void {
    // Use browser EventSource if available, otherwise use fetch-based SSE
    if (typeof EventSource !== 'undefined') {
      this.startBrowserSSE();
    } else {
      this.startNodeSSE().catch((e: any) => {
        if (e?.name !== 'AbortError') {
          log.warn('SSE stream failed', { url: this.sseUrl, error: e });
        }
      });
    }
  }

  private async startNodeSSE(): Promise<void> {
    this.abortController = new AbortController();
    try {
      const fetchInit: Record<string, unknown> = {
        headers: { ...this.customHeaders, Accept: 'text/event-stream' },
        signal: this.abortController.signal,
      };
      if (this.fetchDispatcher) fetchInit.dispatcher = this.fetchDispatcher;
      const response = await fetch(this.sseUrl, fetchInit as RequestInit);

      if (!response.ok) {
        const err = new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
        this.rejectEndpoint(err);
        this.emit('error', err);
        this.emit('close');
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const err = new Error('SSE response has no body');
        this.rejectEndpoint(err);
        this.emit('error', err);
        this.emit('close');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      const processEvent = () => {
        if (!currentData) {
          currentEvent = '';
          return;
        }
        const eventType = currentEvent || 'message';
        const data = currentData.trim();
        currentEvent = '';
        currentData = '';

        if (eventType === 'endpoint') {
          // data is the relative or absolute POST URL
          try {
            const base = new URL(this.sseUrl);
            this.postUrl = new URL(data, base).toString();
          } catch {
            this.postUrl = data;
          }
          // Security: validate the server-provided POST endpoint for SSRF
          try {
            assertUrlSafeForSSRF(this.postUrl!, this.ssrfOptions ?? { allowLocalhost: false });
          } catch (ssrfErr) {
            const err = new Error(
              `MCP server provided unsafe POST endpoint: ${ssrfErr instanceof Error ? ssrfErr.message : ssrfErr}`,
            );
            this.rejectEndpoint(err);
            this.emit('error', err);
            this.emit('close');
            return;
          }
          log.info('SSE endpoint received', { postUrl: this.postUrl });
          this.resolveEndpoint();
        } else if (eventType === 'message') {
          try {
            this.emit('message', JSON.parse(data));
          } catch (e) {
            log.warn('Failed to parse SSE message', { data: data.substring(0, 200), error: e });
          }
        }
      };

      const read = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              processEvent(); // flush any remaining event
              this.emit('close');
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line === '') {
                // Empty line = end of SSE event
                processEvent();
              } else if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                currentData += (currentData ? '\n' : '') + line.slice(6);
              } else if (line.startsWith(':')) {
                // SSE comment, ignore
              }
            }
          }
        } catch (e: any) {
          if (e?.name !== 'AbortError') {
            this.emit('error', e instanceof Error ? e : new Error(String(e)));
            this.emit('close');
          }
        }
      };

      // Start reading in background
      read();
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        const err = e instanceof Error ? e : new Error(String(e));
        this.rejectEndpoint(err);
        this.emit('error', err);
        this.emit('close');
      }
    }
  }

  private startBrowserSSE(): void {
    const eventSource = new EventSource(this.sseUrl);

    // Listen for the endpoint event
    eventSource.addEventListener('endpoint', (event: any) => {
      const data = event.data as string;
      try {
        const base = new URL(this.sseUrl);
        this.postUrl = new URL(data, base).toString();
      } catch {
        this.postUrl = data;
      }
      // Security: validate the server-provided POST endpoint for SSRF
      try {
        assertUrlSafeForSSRF(this.postUrl!, this.ssrfOptions ?? { allowLocalhost: false });
      } catch (ssrfErr) {
        const err = new Error(
          `MCP server provided unsafe POST endpoint: ${ssrfErr instanceof Error ? ssrfErr.message : ssrfErr}`,
        );
        this.rejectEndpoint(err);
        this.emit('error', err);
        this.emit('close');
        eventSource.close();
        return;
      }
      log.info('SSE endpoint received', { postUrl: this.postUrl });
      this.resolveEndpoint();
    });

    // Listen for message events (JSON-RPC responses/notifications)
    eventSource.addEventListener('message', (event: any) => {
      try {
        this.emit('message', JSON.parse(event.data));
      } catch (e) {
        log.warn('Failed to parse SSE message', {
          data: String(event.data).substring(0, 200),
          error: e,
        });
      }
    });

    eventSource.onerror = () => {
      this.rejectEndpoint(new Error('SSE connection error'));
      this.emit('error', new Error('SSE connection error'));
      this.emit('close');
    };

    // Store for cleanup
    (this as any)._eventSource = eventSource;
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.postUrl) {
      this.emit('error', new Error('SSE endpoint not ready — cannot send'));
      return;
    }
    const fetchInit: Record<string, unknown> = {
      method: 'POST',
      headers: { ...this.customHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    };
    if (this.fetchDispatcher) fetchInit.dispatcher = this.fetchDispatcher;
    fetch(this.postUrl, fetchInit as RequestInit).catch((e) => this.emit('error', e));
  }

  close(): void {
    this.abortController?.abort();
    this.abortController = null;
    if ((this as any)._eventSource) {
      (this as any)._eventSource.close();
      (this as any)._eventSource = null;
    }
  }
}

// =============================================================================
// STREAMABLE HTTP TRANSPORT
// =============================================================================

/**
 * Streamable HTTP transport for MCP protocol.
 * Uses HTTP POST for JSON-RPC requests and receives responses inline.
 * Supports optional SSE streaming for server-initiated messages.
 */
class StreamableHTTPTransport extends EventEmitter implements MCPTransport {
  private url: string;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private fetchDispatcher?: unknown;
  private customHeaders?: Record<string, string>;

  constructor(url: string, fetchDispatcher?: unknown, headers?: Record<string, string>) {
    super();
    this.url = url;
    this.fetchDispatcher = fetchDispatcher;
    this.customHeaders = headers;
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    // Custom headers first, then protocol headers take precedence
    const headers: Record<string, string> = {
      ...this.customHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const fetchInit: Record<string, unknown> = {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    };
    if (this.fetchDispatcher) fetchInit.dispatcher = this.fetchDispatcher;

    // Capture id now so we can synthesize a JSON-RPC error if the HTTP response
    // is an error (e.g. 401/403/500) — otherwise pending requests hang until
    // requestTimeoutMs fires.
    const requestId = 'id' in message ? message.id : undefined;

    fetch(this.url, fetchInit as RequestInit)
      .then(async (response) => {
        // Capture session ID from response headers
        const sid = response.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;

        const contentType = response.headers.get('content-type') || '';

        // Fail fast on HTTP errors — don't leave pending JSON-RPC requests
        // waiting for a response that will never arrive.
        if (!response.ok) {
          let bodySnippet = '';
          try {
            bodySnippet = (await response.text()).slice(0, 500);
          } catch {
            // ignore body read failure
          }
          const errMsg = `HTTP ${response.status} ${response.statusText}${
            bodySnippet ? `: ${bodySnippet}` : ''
          }`;
          if (requestId !== undefined) {
            this.emit('message', {
              jsonrpc: '2.0',
              id: requestId,
              error: { code: -32000, message: errMsg },
            });
          } else {
            this.emit('error', new Error(errMsg));
          }
          return;
        }

        if (contentType.includes('text/event-stream')) {
          // Server is streaming back via SSE — parse line by line
          await this.consumeSSEStream(response);
        } else if (contentType.includes('application/json')) {
          let data: unknown;
          try {
            data = await response.json();
          } catch {
            // 202 Accepted with empty body is common for notifications — ignore.
            return;
          }
          // Could be a single response or an array of responses
          if (Array.isArray(data)) {
            for (const item of data) {
              this.emit('message', item);
            }
          } else {
            this.emit('message', data);
          }
        }
      })
      .catch((e) => this.emit('error', e));
  }

  private async consumeSSEStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) {
              try {
                this.emit('message', JSON.parse(data));
              } catch {
                log.warn('Failed to parse SSE stream message', { data: data.substring(0, 200) });
              }
            }
          }
        }
      }
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  close(): void {
    this.abortController?.abort();
    this.abortController = null;

    // Send DELETE to terminate session if we have one
    if (this.sessionId) {
      fetch(this.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': this.sessionId },
      }).catch((err) =>
        log.warn('Failed to send DELETE to terminate MCP HTTP session', {
          url: this.url,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.sessionId = null;
    }
  }
}
