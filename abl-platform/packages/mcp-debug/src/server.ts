/**
 * Arch MCP Server
 *
 * Model Context Protocol server for Agent Platform build, eval, optimize,
 * debug, and analysis workflows.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { WebSocketClient } from './client/websocket-client.js';
import { HttpClient } from './client/http-client.js';
import { SessionStore } from './store/session-store.js';
import { TraceStore } from './store/trace-store.js';
import {
  authenticate as authCascade,
  type AuthResult,
  type AuthOptions,
} from './client/auth-client.js';
import { deriveUrls } from './utils/url.js';
import { DEFAULT_HTTP_URL, DEFAULT_WS_URL } from './constants.js';
import { tools, getTool, zodToJsonSchema, type DebugContext } from './tools/index.js';
import {
  ARCH_MCP_LOG_PREFIX,
  ARCH_MCP_SERVER_NAME,
  formatArchToolDescription,
} from './tools/persona.js';

export interface MCPDebugServerOptions {
  /** Single server URL — derives both HTTP and WS URLs automatically */
  serverUrl?: string;
  /** @deprecated Use serverUrl instead */
  wsUrl?: string;
  /** @deprecated Use serverUrl instead */
  httpUrl?: string;
}

export class MCPDebugServer {
  private server: Server;
  private wsClient: WebSocketClient;
  private httpClient: HttpClient;
  private sessionStore: SessionStore;
  private traceStore: TraceStore;
  private context: DebugContext;

  constructor(options: MCPDebugServerOptions = {}) {
    let wsUrl: string | undefined;
    let httpUrl: string | undefined;

    if (options.serverUrl) {
      // Derive both from single URL
      const derived = deriveUrls(options.serverUrl);
      wsUrl = derived.wsUrl;
      httpUrl = derived.httpUrl;
    } else {
      // Use individual URLs (deprecated), env var defaults, or empty (set via platform_connect)
      wsUrl = options.wsUrl || DEFAULT_WS_URL;
      httpUrl = options.httpUrl || DEFAULT_HTTP_URL;
    }

    this.wsClient = new WebSocketClient({
      url: wsUrl,
      reconnect: true,
      maxReconnectAttempts: 3,
    });

    this.httpClient = new HttpClient(httpUrl);

    this.sessionStore = new SessionStore();
    this.traceStore = new TraceStore();

    // Create context for tools
    this.context = {
      wsClient: this.wsClient,
      httpClient: this.httpClient,
      sessionStore: this.sessionStore,
      traceStore: this.traceStore,
      authenticate: (options?: AuthOptions) => this.authenticate(options),
    };

    // Set up WebSocket event handlers
    this.setupWebSocketHandlers();

    // Create MCP server
    this.server = new Server(
      {
        name: ARCH_MCP_SERVER_NAME,
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // Register handlers
    this.registerHandlers();
  }

  /**
   * Authenticate using the cascade:
   *   explicit token → stored credentials → device auth
   */
  private async authenticate(options?: AuthOptions): Promise<AuthResult> {
    return authCascade(this.httpClient, this.wsClient, options);
  }

  /**
   * Set up WebSocket event handlers to populate stores
   */
  private setupWebSocketHandlers(): void {
    // Handle trace events
    this.wsClient.onTraceEvent = (sessionId, event) => {
      this.traceStore.addEvent(event);
      this.sessionStore.touchSession(sessionId);
    };

    // Handle state updates
    this.wsClient.onStateUpdate = (sessionId, state) => {
      this.sessionStore.updateState(sessionId, state);
    };

    // Handle agent loaded
    this.wsClient.onAgentLoaded = (sessionId, agent) => {
      // Session is created in the loadAgent tool handler
      this.sessionStore.updateAgentDetails(sessionId, agent);
    };

    // Handle connection status
    this.wsClient.onConnected = () => {
      console.error(`${ARCH_MCP_LOG_PREFIX} Connected to server`);
    };

    this.wsClient.onDisconnected = () => {
      console.error(`${ARCH_MCP_LOG_PREFIX} Disconnected from server`);
    };

    this.wsClient.onError = (message) => {
      console.error(`${ARCH_MCP_LOG_PREFIX} WebSocket error:`, message);
    };

    this.wsClient.onInfo = (message, configured) => {
      console.error(`${ARCH_MCP_LOG_PREFIX} ${message} (API configured: ${configured})`);
    };
  }

  /**
   * Register MCP request handlers
   */
  private registerHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: formatArchToolDescription(tool),
          inputSchema: zodToJsonSchema(tool.schema),
        })),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = getTool(name);
      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
      }

      try {
        // Parse and validate arguments
        const parsedArgs = tool.schema.parse(args || {});

        // Execute the tool
        const result = await tool.handler(parsedArgs, this.context);

        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const errorName = error instanceof Error ? error.name : undefined;
        const errorCode = (error as { code?: string }).code;
        const errorCause = error instanceof Error ? error.cause : undefined;

        console.error(`${ARCH_MCP_LOG_PREFIX} Tool "${name}" error:`, {
          name: errorName,
          code: errorCode,
          message,
          cause: errorCause instanceof Error ? errorCause.message : errorCause,
        });

        const errorInfo: Record<string, unknown> = { error: message };
        if (errorName && errorName !== 'Error') errorInfo.errorName = errorName;
        if (errorCode) errorInfo.errorCode = errorCode;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(errorInfo),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`${ARCH_MCP_LOG_PREFIX} Server started`);
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    this.wsClient.disconnect();
    await this.server.close();
    console.error(`${ARCH_MCP_LOG_PREFIX} Server stopped`);
  }
}
