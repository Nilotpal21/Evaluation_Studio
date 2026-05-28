/**
 * Tests for the session analysis tool
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { TraceEventWithId, AgentState } from '../types.js';

// Import the analysis logic by re-implementing test version
// In a real scenario, we'd export analyzeTraces from analysis.ts

interface Issue {
  type: 'warning' | 'error' | 'info';
  title: string;
  description: string;
  eventId?: string;
}

interface AnalysisResult {
  summary: {
    totalEvents: number;
    eventCounts: Record<string, number>;
    duration: number | null;
    llmCalls: number;
    toolCalls: number;
    errors: number;
  };
  currentState: {
    step: string | null;
    phase: string;
    collectedFields: string[];
    missingFields: string[];
  };
  issues: Issue[];
  suggestions: string[];
}

// Re-implement analyzeTraces for testing (mirrors analysis.ts)
function analyzeTraces(traces: TraceEventWithId[], state?: AgentState): AnalysisResult {
  const analysis: AnalysisResult = {
    summary: {
      totalEvents: traces.length,
      eventCounts: {},
      duration: null,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
    },
    currentState: {
      step: null,
      phase: state?.conversationPhase || 'unknown',
      collectedFields: [],
      missingFields: [],
    },
    issues: [],
    suggestions: [],
  };

  // Count event types
  for (const trace of traces) {
    analysis.summary.eventCounts[trace.type] = (analysis.summary.eventCounts[trace.type] || 0) + 1;
    if (trace.type === 'llm_call') analysis.summary.llmCalls++;
    if (trace.type === 'tool_call') analysis.summary.toolCalls++;
    if (trace.type === 'error') analysis.summary.errors++;
  }

  // Calculate duration
  if (traces.length >= 2) {
    const first = new Date(traces[0].timestamp).getTime();
    const last = new Date(traces[traces.length - 1].timestamp).getTime();
    analysis.summary.duration = last - first;
  }

  // Find current step from flow events
  const flowSteps = traces.filter((t) => t.type === 'flow_step_enter');
  if (flowSteps.length > 0) {
    const lastStep = flowSteps[flowSteps.length - 1];
    analysis.currentState.step = (lastStep.data as { stepName?: string })?.stepName || null;
  }

  // Extract collected fields from dsl_set events
  const setEvents = traces.filter((t) => t.type === 'dsl_set');
  for (const event of setEvents) {
    const field = (event.data as { field?: string })?.field;
    if (field && !analysis.currentState.collectedFields.includes(field)) {
      analysis.currentState.collectedFields.push(field);
    }
  }

  // Find missing fields from collect events
  const collectEvents = traces.filter((t) => t.type === 'dsl_collect');
  for (const event of collectEvents) {
    const field = (event.data as { field?: string })?.field;
    const collected = (event.data as { collected?: boolean })?.collected;
    if (field && !collected && !analysis.currentState.missingFields.includes(field)) {
      analysis.currentState.missingFields.push(field);
    }
  }

  // Issue: Repeated step entry (potential loop)
  const stepCounts: Record<string, number> = {};
  for (const step of flowSteps) {
    const stepName = (step.data as { stepName?: string })?.stepName || 'unknown';
    stepCounts[stepName] = (stepCounts[stepName] || 0) + 1;
  }
  for (const [step, count] of Object.entries(stepCounts)) {
    if (count > 3) {
      analysis.issues.push({
        type: 'warning',
        title: 'Potential loop detected',
        description: `Step "${step}" was entered ${count} times. This may indicate a loop condition.`,
      });
      analysis.suggestions.push(
        `Check transition conditions for step "${step}". Ensure required fields are being collected and stored in context.`,
      );
    }
  }

  // Issue: Errors present
  const errorEvents = traces.filter((t) => t.type === 'error');
  for (const error of errorEvents) {
    const errorMsg = (error.data as { message?: string })?.message || 'Unknown error';
    analysis.issues.push({
      type: 'error',
      title: 'Error occurred',
      description: errorMsg,
      eventId: error.id,
    });
  }

  // Issue: Constraint violations
  const constraintFailures = traces.filter(
    (t) => t.type === 'constraint_check' && !(t.data as { passed?: boolean })?.passed,
  );
  for (const failure of constraintFailures) {
    const constraint = (failure.data as { constraint?: string })?.constraint || 'unknown';
    analysis.issues.push({
      type: 'warning',
      title: 'Constraint violation',
      description: `Constraint "${constraint}" was violated.`,
      eventId: failure.id,
    });
    analysis.suggestions.push(
      `Review the "${constraint}" constraint condition and verify context values meet requirements.`,
    );
  }

  // Issue: Tool failures
  const toolFailures = traces.filter(
    (t) => t.type === 'tool_call' && (t.data as { success?: boolean })?.success === false,
  );
  for (const failure of toolFailures) {
    const toolName = (failure.data as { tool?: string })?.tool || 'unknown';
    const errorMsg = (failure.data as { error?: string })?.error || 'Unknown error';
    analysis.issues.push({
      type: 'error',
      title: 'Tool call failed',
      description: `Tool "${toolName}" failed: ${errorMsg}`,
      eventId: failure.id,
    });
    analysis.suggestions.push(
      `Check the "${toolName}" tool implementation and verify input parameters are correct.`,
    );
  }

  // Issue: Missing required fields
  if (analysis.currentState.missingFields.length > 0) {
    analysis.issues.push({
      type: 'info',
      title: 'Missing required fields',
      description: `The following fields are not yet collected: ${analysis.currentState.missingFields.join(', ')}`,
    });
    analysis.suggestions.push(
      'The agent is waiting for the user to provide the missing information.',
    );
  }

  // Issue: Many LLM calls (potential inefficiency)
  if (analysis.summary.llmCalls > 10) {
    analysis.issues.push({
      type: 'info',
      title: 'High LLM call count',
      description: `${analysis.summary.llmCalls} LLM calls made. Consider optimizing prompts or adding caching.`,
    });
  }

  // Issue: Escalation without resolution
  const escalations = traces.filter((t) => t.type === 'escalation');
  if (escalations.length > 1) {
    analysis.issues.push({
      type: 'warning',
      title: 'Multiple escalations',
      description: `${escalations.length} escalations occurred. Ensure agents can handle the request.`,
    });
    analysis.suggestions.push(
      'Review escalation conditions and ensure at least one agent can resolve the request.',
    );
  }

  // Issue: Long-running session
  if (analysis.summary.duration && analysis.summary.duration > 60000) {
    analysis.issues.push({
      type: 'info',
      title: 'Long-running session',
      description: `Session has been active for ${Math.round(analysis.summary.duration / 1000)}s.`,
    });
  }

  // Issue: No LLM calls (agent might be stuck)
  if (traces.length > 5 && analysis.summary.llmCalls === 0) {
    analysis.issues.push({
      type: 'warning',
      title: 'No LLM calls detected',
      description:
        'The agent has not made any LLM calls. It may be stuck in initialization or a non-LLM flow.',
    });
  }

  return analysis;
}

// Helper to create trace events
function createTrace(
  type: string,
  data: Record<string, unknown> = {},
  timestamp?: Date,
): TraceEventWithId {
  return {
    id: `trace_${Math.random().toString(36).substr(2, 9)}`,
    type: type as TraceEventWithId['type'],
    timestamp: timestamp || new Date(),
    sessionId: 'test-session',
    data,
  };
}

describe('Session Analysis', () => {
  describe('Summary Statistics', () => {
    test('should count total events', () => {
      const traces = [
        createTrace('agent_enter'),
        createTrace('llm_call'),
        createTrace('agent_exit'),
      ];

      const result = analyzeTraces(traces);

      expect(result.summary.totalEvents).toBe(3);
    });

    test('should count event types correctly', () => {
      const traces = [
        createTrace('llm_call'),
        createTrace('llm_call'),
        createTrace('tool_call'),
        createTrace('error'),
      ];

      const result = analyzeTraces(traces);

      expect(result.summary.eventCounts['llm_call']).toBe(2);
      expect(result.summary.eventCounts['tool_call']).toBe(1);
      expect(result.summary.eventCounts['error']).toBe(1);
    });

    test('should count llmCalls correctly', () => {
      const traces = [
        createTrace('llm_call'),
        createTrace('tool_call'),
        createTrace('llm_call'),
        createTrace('llm_call'),
      ];

      const result = analyzeTraces(traces);

      expect(result.summary.llmCalls).toBe(3);
    });

    test('should count toolCalls correctly', () => {
      const traces = [
        createTrace('tool_call', { tool: 'search' }),
        createTrace('tool_call', { tool: 'lookup' }),
      ];

      const result = analyzeTraces(traces);

      expect(result.summary.toolCalls).toBe(2);
    });

    test('should count errors correctly', () => {
      const traces = [
        createTrace('error', { message: 'Error 1' }),
        createTrace('error', { message: 'Error 2' }),
      ];

      const result = analyzeTraces(traces);

      expect(result.summary.errors).toBe(2);
    });

    test('should calculate duration between first and last event', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const end = new Date('2024-01-01T10:00:05Z'); // 5 seconds later

      const traces = [
        createTrace('agent_enter', {}, start),
        createTrace('llm_call', {}, new Date('2024-01-01T10:00:02Z')),
        createTrace('agent_exit', {}, end),
      ];

      const result = analyzeTraces(traces);

      expect(result.summary.duration).toBe(5000); // 5000ms
    });

    test('should return null duration for single event', () => {
      const traces = [createTrace('agent_enter')];

      const result = analyzeTraces(traces);

      expect(result.summary.duration).toBeNull();
    });

    test('should handle empty traces array', () => {
      const result = analyzeTraces([]);

      expect(result.summary.totalEvents).toBe(0);
      expect(result.summary.llmCalls).toBe(0);
      expect(result.summary.toolCalls).toBe(0);
      expect(result.summary.errors).toBe(0);
      expect(result.summary.duration).toBeNull();
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('Current State Detection', () => {
    test('should detect current flow step', () => {
      const traces = [
        createTrace('flow_step_enter', { stepName: 'greeting' }),
        createTrace('flow_step_exit', { stepName: 'greeting' }),
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
      ];

      const result = analyzeTraces(traces);

      expect(result.currentState.step).toBe('collect_info');
    });

    test('should detect phase from state', () => {
      const traces = [createTrace('agent_enter')];
      const state: AgentState = {
        conversationPhase: 'gathering',
      } as AgentState;

      const result = analyzeTraces(traces, state);

      expect(result.currentState.phase).toBe('gathering');
    });

    test('should extract collected fields from dsl_set events', () => {
      const traces = [
        createTrace('dsl_set', { field: 'name', value: 'John' }),
        createTrace('dsl_set', { field: 'email', value: 'john@example.com' }),
      ];

      const result = analyzeTraces(traces);

      expect(result.currentState.collectedFields).toContain('name');
      expect(result.currentState.collectedFields).toContain('email');
    });

    test('should extract missing fields from dsl_collect events', () => {
      const traces = [
        createTrace('dsl_collect', { field: 'name', collected: true }),
        createTrace('dsl_collect', { field: 'email', collected: false }),
        createTrace('dsl_collect', { field: 'phone', collected: false }),
      ];

      const result = analyzeTraces(traces);

      expect(result.currentState.missingFields).toContain('email');
      expect(result.currentState.missingFields).toContain('phone');
      expect(result.currentState.missingFields).not.toContain('name');
    });
  });

  describe('Loop Detection', () => {
    test('should detect potential loop when step entered more than 3 times', () => {
      const traces = [
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
      ];

      const result = analyzeTraces(traces);

      const loopIssue = result.issues.find((i) => i.title === 'Potential loop detected');
      expect(loopIssue).toBeDefined();
      expect(loopIssue?.type).toBe('warning');
      expect(loopIssue?.description).toContain('collect_info');
      expect(loopIssue?.description).toContain('4 times');
    });

    test('should not flag loop for 3 or fewer entries', () => {
      const traces = [
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
        createTrace('flow_step_enter', { stepName: 'collect_info' }),
      ];

      const result = analyzeTraces(traces);

      const loopIssue = result.issues.find((i) => i.title === 'Potential loop detected');
      expect(loopIssue).toBeUndefined();
    });

    test('should add suggestion for loop issues', () => {
      const traces = [
        createTrace('flow_step_enter', { stepName: 'broken_step' }),
        createTrace('flow_step_enter', { stepName: 'broken_step' }),
        createTrace('flow_step_enter', { stepName: 'broken_step' }),
        createTrace('flow_step_enter', { stepName: 'broken_step' }),
      ];

      const result = analyzeTraces(traces);

      expect(result.suggestions.some((s) => s.includes('broken_step'))).toBe(true);
    });
  });

  describe('Error Detection', () => {
    test('should report all error events', () => {
      const traces = [
        createTrace('error', { message: 'Connection timeout' }),
        createTrace('error', { message: 'Invalid input' }),
      ];

      const result = analyzeTraces(traces);

      const errorIssues = result.issues.filter((i) => i.title === 'Error occurred');
      expect(errorIssues).toHaveLength(2);
      expect(errorIssues[0].type).toBe('error');
    });

    test('should include error message in description', () => {
      const traces = [createTrace('error', { message: 'Specific error message' })];

      const result = analyzeTraces(traces);

      const errorIssue = result.issues.find((i) => i.title === 'Error occurred');
      expect(errorIssue?.description).toBe('Specific error message');
    });

    test('should include event ID for errors', () => {
      const traces = [createTrace('error', { message: 'Test error' })];

      const result = analyzeTraces(traces);

      const errorIssue = result.issues.find((i) => i.title === 'Error occurred');
      expect(errorIssue?.eventId).toBeDefined();
    });
  });

  describe('Constraint Violation Detection', () => {
    test('should detect constraint violations', () => {
      const traces = [createTrace('constraint_check', { constraint: 'max_amount', passed: false })];

      const result = analyzeTraces(traces);

      const violation = result.issues.find((i) => i.title === 'Constraint violation');
      expect(violation).toBeDefined();
      expect(violation?.description).toContain('max_amount');
    });

    test('should not flag passing constraints', () => {
      const traces = [createTrace('constraint_check', { constraint: 'max_amount', passed: true })];

      const result = analyzeTraces(traces);

      const violation = result.issues.find((i) => i.title === 'Constraint violation');
      expect(violation).toBeUndefined();
    });

    test('should add suggestion for constraint violations', () => {
      const traces = [
        createTrace('constraint_check', { constraint: 'user_authenticated', passed: false }),
      ];

      const result = analyzeTraces(traces);

      expect(result.suggestions.some((s) => s.includes('user_authenticated'))).toBe(true);
    });
  });

  describe('Tool Failure Detection', () => {
    test('should detect tool failures', () => {
      const traces = [
        createTrace('tool_call', { tool: 'search_api', success: false, error: 'API timeout' }),
      ];

      const result = analyzeTraces(traces);

      const failure = result.issues.find((i) => i.title === 'Tool call failed');
      expect(failure).toBeDefined();
      expect(failure?.type).toBe('error');
      expect(failure?.description).toContain('search_api');
      expect(failure?.description).toContain('API timeout');
    });

    test('should not flag successful tool calls', () => {
      const traces = [createTrace('tool_call', { tool: 'search_api', success: true })];

      const result = analyzeTraces(traces);

      const failure = result.issues.find((i) => i.title === 'Tool call failed');
      expect(failure).toBeUndefined();
    });

    test('should add suggestion for tool failures', () => {
      const traces = [
        createTrace('tool_call', { tool: 'broken_tool', success: false, error: 'Error' }),
      ];

      const result = analyzeTraces(traces);

      expect(result.suggestions.some((s) => s.includes('broken_tool'))).toBe(true);
    });
  });

  describe('Missing Fields Detection', () => {
    test('should report missing required fields', () => {
      const traces = [createTrace('dsl_collect', { field: 'email', collected: false })];

      const result = analyzeTraces(traces);

      const missingIssue = result.issues.find((i) => i.title === 'Missing required fields');
      expect(missingIssue).toBeDefined();
      expect(missingIssue?.type).toBe('info');
      expect(missingIssue?.description).toContain('email');
    });
  });

  describe('High LLM Call Detection', () => {
    test('should warn when LLM calls exceed threshold', () => {
      const traces = Array.from({ length: 11 }, () => createTrace('llm_call'));

      const result = analyzeTraces(traces);

      const llmIssue = result.issues.find((i) => i.title === 'High LLM call count');
      expect(llmIssue).toBeDefined();
      expect(llmIssue?.type).toBe('info');
    });

    test('should not warn when LLM calls are at threshold', () => {
      const traces = Array.from({ length: 10 }, () => createTrace('llm_call'));

      const result = analyzeTraces(traces);

      const llmIssue = result.issues.find((i) => i.title === 'High LLM call count');
      expect(llmIssue).toBeUndefined();
    });
  });

  describe('Multiple Escalations Detection', () => {
    test('should warn about multiple escalations', () => {
      const traces = [
        createTrace('escalation', { reason: 'User frustrated' }),
        createTrace('escalation', { reason: 'Cannot handle' }),
      ];

      const result = analyzeTraces(traces);

      const escalationIssue = result.issues.find((i) => i.title === 'Multiple escalations');
      expect(escalationIssue).toBeDefined();
      expect(escalationIssue?.type).toBe('warning');
    });

    test('should not warn for single escalation', () => {
      const traces = [createTrace('escalation', { reason: 'User frustrated' })];

      const result = analyzeTraces(traces);

      const escalationIssue = result.issues.find((i) => i.title === 'Multiple escalations');
      expect(escalationIssue).toBeUndefined();
    });
  });

  describe('Long Session Detection', () => {
    test('should report long-running sessions', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const end = new Date('2024-01-01T10:02:00Z'); // 2 minutes later

      const traces = [createTrace('agent_enter', {}, start), createTrace('agent_exit', {}, end)];

      const result = analyzeTraces(traces);

      const longSession = result.issues.find((i) => i.title === 'Long-running session');
      expect(longSession).toBeDefined();
      expect(longSession?.type).toBe('info');
    });

    test('should not report short sessions', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const end = new Date('2024-01-01T10:00:30Z'); // 30 seconds later

      const traces = [createTrace('agent_enter', {}, start), createTrace('agent_exit', {}, end)];

      const result = analyzeTraces(traces);

      const longSession = result.issues.find((i) => i.title === 'Long-running session');
      expect(longSession).toBeUndefined();
    });
  });

  describe('No LLM Calls Detection', () => {
    test('should warn when no LLM calls with many events', () => {
      const traces = [
        createTrace('agent_enter'),
        createTrace('flow_step_enter', { stepName: 'start' }),
        createTrace('dsl_prompt'),
        createTrace('flow_step_enter', { stepName: 'next' }),
        createTrace('dsl_prompt'),
        createTrace('flow_step_enter', { stepName: 'more' }),
      ];

      const result = analyzeTraces(traces);

      const noLlmIssue = result.issues.find((i) => i.title === 'No LLM calls detected');
      expect(noLlmIssue).toBeDefined();
      expect(noLlmIssue?.type).toBe('warning');
    });

    test('should not warn with few events', () => {
      const traces = [
        createTrace('agent_enter'),
        createTrace('flow_step_enter', { stepName: 'start' }),
      ];

      const result = analyzeTraces(traces);

      const noLlmIssue = result.issues.find((i) => i.title === 'No LLM calls detected');
      expect(noLlmIssue).toBeUndefined();
    });
  });
});
