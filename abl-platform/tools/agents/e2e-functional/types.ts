/**
 * Shared types for the functional E2E test suite.
 */

// ─── Scenario Types ─────────────────────────────────────────────────────────

export interface ScenarioResult {
  id: number;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  details?: string;
}

export interface ScenarioContext {
  sandbox: ExtendedSandbox;
  studioUrl: string;
  runtimeUrl: string;
  mockLlm: MockLLM;
  mockToolServer: MockToolServer;
  mockMcpServer: MockMcpServer;
  realLlm: boolean;
  scenarioTimeoutMs: number;
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<ScenarioResult>;

// ─── Extended Sandbox ───────────────────────────────────────────────────────

export interface ExtendedSandbox {
  tenantId: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  authToken: string;
  cleanup: () => Promise<void>;
  // LLM setup (optional — only when mockLlmUrl or realLlm is set)
  tenantCredentialId?: string;
  tenantModelId?: string;
  tenantModelConnectionId?: string;
}

// ─── Mock LLM Server ────────────────────────────────────────────────────────

export interface MockResponse {
  content: string;
  finishReason?: string;
}

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
  followUpContent: string;
}

/**
 * Dynamic tool call definition. Instead of fixed arguments, extracts
 * values from the LLM request message corpus using regex capture groups
 * and injects them into the tool call arguments.
 *
 * Example: extract a PII token from the user message and echo it as a
 * tool argument — simulating an LLM that echoes tokenized PII back.
 */
export interface DynamicToolCall {
  name: string;
  /** Map from argument name to regex with a capture group.
   *  The regex is applied to the full message corpus. Group 0 (full match)
   *  is used as the argument value. */
  argExtractors: Record<string, RegExp>;
  /** Static arguments merged with extracted values (extractors override). */
  staticArgs?: Record<string, unknown>;
  followUpContent: string;
}

/**
 * Error response definition for simulating LLM provider errors.
 *
 * When registered, the mock LLM returns an HTTP error response matching the
 * provider's error shape instead of a successful completion. The Vercel AI SDK
 * (or OpenAI SDK) translates these into Error objects with `.status`, `.code`,
 * `.message`, and `.responseBody` — which classifyLlmError then classifies.
 */
export interface MockErrorResponse {
  /** HTTP status code to return (e.g. 400, 429, 500) */
  status: number;
  /** Error body matching the OpenAI / Azure error envelope */
  body: {
    error: {
      message: string;
      type?: string;
      code?: string;
      /** Azure-specific inner error with content_filter_result */
      innererror?: {
        content_filter_result?: Record<
          string,
          {
            severity?: string;
            filtered?: boolean;
            detected?: boolean;
          }
        >;
      };
    };
  };
}

export interface MockLLM {
  url: string;
  port: number;
  register(pattern: string, response: MockResponse): void;
  registerToolCall(pattern: string, toolCall: MockToolCall): void;
  /**
   * Register a dynamic tool call that extracts argument values from the
   * LLM request message corpus using regex capture groups.
   *
   * Example: extract a PII token `{{PII:ssn:UUID}}` and echo it in the
   * tool call arguments so the runtime's vault can resolve it.
   */
  registerDynamicToolCall(pattern: string, dynamicToolCall: DynamicToolCall): void;
  /**
   * Register an error response: when the user message matches `pattern`,
   * the mock LLM returns an HTTP error instead of a successful completion.
   *
   * The error shape matches the OpenAI / Azure error envelope so the
   * Vercel AI SDK translates it into a typed error that classifyLlmError
   * can classify (e.g. content_filter → MODEL_CONTENT_FILTERED).
   */
  registerError(pattern: string, errorResponse: MockErrorResponse): void;
  getLastRequest(): OpenAIChatRequest | undefined;
  getAllRequests(): OpenAIChatRequest[];
  reset(): void;
  close(): Promise<void>;
}

export interface OpenAIChatMessageContentPart {
  type?: string;
  text?: string;
  image_url?: string | { url?: string; detail?: string };
  content?: string;
  [key: string]: unknown;
}

export type OpenAIChatMessageContent =
  | string
  | OpenAIChatMessageContentPart[]
  | Record<string, unknown>
  | null;

/** Subset of the OpenAI chat completions request we inspect in tests */
export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: string; content: OpenAIChatMessageContent }>;
  stream?: boolean;
  tools?: unknown[];
}

// ─── Mock Tool Server ───────────────────────────────────────────────────────

export interface MockToolServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

// ─── Mock MCP Server ────────────────────────────────────────────────────────

export interface MockMcpServer {
  /** stdio transport command for agent DSL: e.g. "node /path/to/mock-mcp-server.js" */
  command: string;
  args: string[];
  close(): Promise<void>;
}
