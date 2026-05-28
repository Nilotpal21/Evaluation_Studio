/**
 * Test Context Types
 *
 * Shared types for agent test context injection.
 * Used by both runtime (WebSocket/REST handlers) and studio (UI/store).
 */

// =============================================================================
// TOOL MOCK CONFIGURATION
// =============================================================================

/** Per-tool mock configuration */
export interface ToolMockConfig {
  /** Tool name to mock */
  toolName: string;
  /** Static return value */
  response?: unknown;
  /** Whether the mock should indicate success (default: true) */
  success?: boolean;
  /** Error to return when success is false */
  error?: { code: string; message: string };
  /** Simulate latency in milliseconds */
  delayMs?: number;
  /** Only mock when tool params shallow-match these values */
  matchParams?: Record<string, unknown>;
}

// =============================================================================
// TEST CONTEXT PAYLOAD (session creation)
// =============================================================================

/** Initial context for session creation via load_agent_with_context */
export interface TestContextPayload {
  /** Pre-fill GATHER fields (skip data collection) */
  gatherValues?: Record<string, unknown>;
  /** SET session variables (simulate tool results, user attributes) */
  sessionVariables?: Record<string, unknown>;
  /** Caller context overrides (simulate different personas) */
  callerContext?: {
    userId?: string;
    channel?: string;
    customAttributes?: Record<string, unknown>;
  };
  /** Mock tool responses */
  toolMocks?: ToolMockConfig[];
  /** Skip ON_START execution */
  skipOnStart?: boolean;
  /** Jump to a specific flow step (scripted agents only) */
  startAtStep?: string;
}

// =============================================================================
// CONTEXT INJECTION (mid-session)
// =============================================================================

/** Mid-session context update */
export interface ContextInjection {
  /** Values to set/override in session data */
  values?: Record<string, unknown>;
  /** Mark these keys as user-gathered (affects gather progress display) */
  markAsGathered?: string[];
  /** Add or update tool mocks */
  toolMocks?: ToolMockConfig[];
  /** Jump to a specific flow step (scripted agents only) */
  forceStep?: string;
}

// =============================================================================
// TEST SCENARIO (saved reusable configuration)
// =============================================================================

/** Saved reusable test configuration */
export interface TestScenario {
  id: string;
  name: string;
  description: string;
  agentPath: string;
  projectId?: string;
  context: TestContextPayload;
  createdAt: string;
  updatedAt: string;
}
