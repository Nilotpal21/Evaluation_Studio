/**
 * Test Context Types (Studio)
 *
 * Mirrors runtime types for agent test context injection.
 * Kept in sync with apps/runtime/src/types/test-context.ts.
 */

// =============================================================================
// TOOL MOCK CONFIGURATION
// =============================================================================

export interface ToolMockConfig {
  toolName: string;
  response?: unknown;
  success?: boolean;
  error?: { code: string; message: string };
  delayMs?: number;
  matchParams?: Record<string, unknown>;
}

// =============================================================================
// TEST CONTEXT PAYLOAD
// =============================================================================

export interface TestContextPayload {
  gatherValues?: Record<string, unknown>;
  sessionVariables?: Record<string, unknown>;
  callerContext?: {
    userId?: string;
    channel?: string;
    customAttributes?: Record<string, unknown>;
  };
  toolMocks?: ToolMockConfig[];
  skipOnStart?: boolean;
  startAtStep?: string;
}

// =============================================================================
// CONTEXT INJECTION
// =============================================================================

export interface ContextInjection {
  values?: Record<string, unknown>;
  markAsGathered?: string[];
  toolMocks?: ToolMockConfig[];
  forceStep?: string;
}

// =============================================================================
// TEST SCENARIO
// =============================================================================

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
