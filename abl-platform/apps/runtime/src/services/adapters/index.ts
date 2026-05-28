/**
 * Adapters Index
 *
 * These adapters implement interfaces from @abl/compiler for construct-based execution.
 * They bridge the server's runtime with the compiler's abstract interfaces.
 *
 * Adapters:
 * - TestAgentRegistry: Implements ConstructAgentRegistry for handoff/delegate lookup
 * - TestTraceManager: Implements TraceContextManager for span-based tracing
 *
 * NOTE: MockToolExecutor and getDefaultMockResponses have been removed.
 * For production no-op fallback, use NoOpToolExecutor from execution/noop-tool-executor.ts.
 * For debug/test mock injection, use MockToolExecutor from execution/mock-tool-executor.ts.
 */

export { TestAgentRegistry } from './agent-registry-adapter.js';
export {
  TestTraceManager,
  type TraceEvent,
  type TraceEventCallback,
} from './trace-manager-adapter.js';
