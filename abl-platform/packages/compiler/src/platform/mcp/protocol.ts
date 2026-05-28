/**
 * MCP Protocol Types
 *
 * Full Model Context Protocol specification.
 * https://modelcontextprotocol.io/specification
 */

// =============================================================================
// CORE TYPES
// =============================================================================

/**
 * JSON-RPC request/response types
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// =============================================================================
// PROTOCOL METHODS
// =============================================================================

/**
 * MCP method names
 */
export type MCPMethod =
  // Lifecycle
  | 'initialize'
  | 'initialized'
  | 'shutdown'
  // Tools
  | 'tools/list'
  | 'tools/call'
  // Resources
  | 'resources/list'
  | 'resources/read'
  | 'resources/subscribe'
  | 'resources/unsubscribe'
  // Prompts
  | 'prompts/list'
  | 'prompts/get'
  // Sampling (client → server)
  | 'sampling/createMessage'
  // Logging
  | 'logging/setLevel'
  // Notifications
  | 'notifications/message'
  | 'notifications/resources/updated'
  | 'notifications/resources/list_changed'
  | 'notifications/tools/list_changed'
  | 'notifications/prompts/list_changed'
  | 'notifications/progress'
  | 'notifications/cancelled';

// =============================================================================
// INITIALIZE
// =============================================================================

export interface InitializeParams {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

export interface ClientCapabilities {
  experimental?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  roots?: {
    listChanged?: boolean;
  };
}

export interface ServerCapabilities {
  experimental?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

// =============================================================================
// TOOLS
// =============================================================================

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: MCPToolInputSchema;
}

export interface MCPToolInputSchema {
  type: 'object';
  properties?: Record<string, MCPToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface MCPToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: MCPToolProperty;
  properties?: Record<string, MCPToolProperty>;
  required?: string[];
  default?: unknown;
}

export interface ToolsListResult {
  tools: MCPTool[];
  nextCursor?: string;
}

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResult {
  content: MCPContent[];
  isError?: boolean;
}

// =============================================================================
// RESOURCES
// =============================================================================

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourcesListResult {
  resources: MCPResource[];
  nextCursor?: string;
}

export interface ResourceReadParams {
  uri: string;
}

export interface ResourceReadResult {
  contents: MCPResourceContent[];
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64 encoded
}

export interface ResourceSubscribeParams {
  uri: string;
}

export interface ResourceUnsubscribeParams {
  uri: string;
}

// =============================================================================
// PROMPTS
// =============================================================================

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptsListResult {
  prompts: MCPPrompt[];
  nextCursor?: string;
}

export interface PromptGetParams {
  name: string;
  arguments?: Record<string, string>;
}

export interface PromptGetResult {
  description?: string;
  messages: MCPPromptMessage[];
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: MCPContent;
}

// =============================================================================
// CONTENT TYPES
// =============================================================================

export type MCPContent = MCPTextContent | MCPImageContent | MCPEmbeddedResource;

export interface MCPTextContent {
  type: 'text';
  text: string;
}

export interface MCPImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export interface MCPEmbeddedResource {
  type: 'resource';
  resource: MCPResourceContent;
}

// =============================================================================
// SAMPLING (Client → Server)
// =============================================================================

export interface SamplingCreateMessageParams {
  messages: MCPSamplingMessage[];
  modelPreferences?: MCPModelPreferences;
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface MCPSamplingMessage {
  role: 'user' | 'assistant';
  content: MCPContent;
}

export interface MCPModelPreferences {
  hints?: MCPModelHint[];
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface MCPModelHint {
  name?: string;
}

export interface SamplingCreateMessageResult {
  role: 'assistant';
  content: MCPContent;
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

// =============================================================================
// LOGGING
// =============================================================================

export type MCPLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export interface LoggingSetLevelParams {
  level: MCPLogLevel;
}

export interface LoggingMessageNotification {
  level: MCPLogLevel;
  logger?: string;
  data: unknown;
}

// =============================================================================
// NOTIFICATIONS
// =============================================================================

export interface ProgressNotification {
  progressToken: string | number;
  progress: number;
  total?: number;
}

export interface CancelledNotification {
  requestId: string | number;
  reason?: string;
}

// =============================================================================
// ERROR CODES
// =============================================================================

export const MCPErrorCodes = {
  // JSON-RPC standard errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // MCP-specific errors
  REQUEST_CANCELLED: -32000,
  CONTENT_TOO_LARGE: -32001,
} as const;

// =============================================================================
// PROTOCOL CONSTANTS
// =============================================================================

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_SUPPORTED_VERSIONS = ['2024-11-05', '2024-10-07'];
