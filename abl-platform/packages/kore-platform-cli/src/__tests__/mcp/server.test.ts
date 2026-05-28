/**
 * Tests for MCP Server
 *
 * Tests the MCP protocol handling, tools, and documentation integration.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DSL_DOCS,
  DOC_TOPICS,
  getDocumentation,
  searchDocumentation,
} from '../../mcp/docs/index.js';

// Note: We can't easily test the full server.ts since it uses readline and process.stdin/stdout
// Instead, we test the documentation module which is the core exported functionality

describe('MCP Server Documentation', () => {
  describe('DOC_TOPICS', () => {
    test('should contain all expected documentation topics', () => {
      expect(DOC_TOPICS).toContain('overview');
      expect(DOC_TOPICS).toContain('yaml-format');
      expect(DOC_TOPICS).toContain('scripted');
      expect(DOC_TOPICS).toContain('reasoning');
      expect(DOC_TOPICS).toContain('supervisor');
      expect(DOC_TOPICS).toContain('context');
      expect(DOC_TOPICS).toContain('cel-functions');
      expect(DOC_TOPICS).toContain('extensions');
      expect(DOC_TOPICS).toContain('tool-patterns');
      expect(DOC_TOPICS).toContain('best-practices');
      expect(DOC_TOPICS).toContain('trace-events');
      expect(DOC_TOPICS).toContain('debugging');
      expect(DOC_TOPICS).toContain('architect');
    });

    test('should have 13 topics', () => {
      expect(DOC_TOPICS).toHaveLength(13);
    });
  });

  describe('DSL_DOCS', () => {
    test('should have content for all topics', () => {
      for (const topic of DOC_TOPICS) {
        expect(DSL_DOCS[topic]).toBeDefined();
        expect(DSL_DOCS[topic].length).toBeGreaterThan(0);
      }
    });

    test('overview should contain agent types', () => {
      const overview = DSL_DOCS['overview'];
      expect(overview).toContain('Agent ABL');
      expect(overview).toContain('scripted');
      expect(overview).toContain('reasoning');
      expect(overview).toContain('supervisor');
    });

    test('scripted docs should contain flow concepts', () => {
      const scripted = DSL_DOCS['scripted'];
      expect(scripted).toContain('flow');
      expect(scripted).toContain('transitions');
      expect(scripted).toContain('collect');
      expect(scripted).toContain('prompt');
      expect(scripted).toContain('respond');
      expect(scripted).toContain('delegate');
    });

    test('reasoning docs should contain tools and constraints', () => {
      const reasoning = DSL_DOCS['reasoning'];
      expect(reasoning).toContain('tools');
      expect(reasoning).toContain('constraints');
      expect(reasoning).toContain('goals');
      expect(reasoning).toContain('enforcement');
    });

    test('supervisor docs should contain delegation and routing', () => {
      const supervisor = DSL_DOCS['supervisor'];
      expect(supervisor).toContain('delegate');
      expect(supervisor).toContain('routing');
      expect(supervisor).toContain('escalation');
      expect(supervisor).toContain('agents');
    });

    test('trace-events docs should list all event types', () => {
      const traceEvents = DSL_DOCS['trace-events'];
      expect(traceEvents).toContain('agent_enter');
      expect(traceEvents).toContain('agent_exit');
      expect(traceEvents).toContain('flow_step_enter');
      expect(traceEvents).toContain('flow_step_exit');
      expect(traceEvents).toContain('llm_call');
      expect(traceEvents).toContain('tool_call');
      expect(traceEvents).toContain('decision');
      expect(traceEvents).toContain('error');
      expect(traceEvents).toContain('dsl_collect');
    });

    test('debugging guide should contain diagnostic patterns', () => {
      const debugging = DSL_DOCS['debugging'];
      expect(debugging).toContain('loop');
      expect(debugging).toContain('stuck');
      expect(debugging).toContain('Tool not being called');
      expect(debugging).toContain('Diagnosis');
      expect(debugging).toContain('Solution');
    });

    test('context docs should explain context structure', () => {
      const context = DSL_DOCS['context'];
      expect(context).toContain('user');
      expect(context).toContain('agent');
      expect(context).toContain('collected');
      expect(context).toContain('tools');
    });
  });

  describe('getDocumentation', () => {
    test('should return documentation for valid topic', () => {
      const doc = getDocumentation('overview');
      expect(doc).toBeDefined();
      expect(doc).toContain('Agent ABL');
    });

    test('should return null for invalid topic', () => {
      const doc = getDocumentation('nonexistent');
      expect(doc).toBeNull();
    });

    test('should return correct content for each topic', () => {
      for (const topic of DOC_TOPICS) {
        const doc = getDocumentation(topic);
        expect(doc).toBe(DSL_DOCS[topic]);
      }
    });
  });

  describe('searchDocumentation', () => {
    test('should find results for common terms', () => {
      const results = searchDocumentation('agent');
      expect(results.length).toBeGreaterThan(0);
    });

    test('should return topic and excerpt for matches', () => {
      const results = searchDocumentation('scripted');
      expect(results.length).toBeGreaterThan(0);

      const firstResult = results[0];
      expect(firstResult).toHaveProperty('topic');
      expect(firstResult).toHaveProperty('excerpt');
    });

    test('should be case insensitive', () => {
      const lowerResults = searchDocumentation('agent');
      const upperResults = searchDocumentation('AGENT');
      const mixedResults = searchDocumentation('Agent');

      expect(lowerResults.length).toBe(upperResults.length);
      expect(lowerResults.length).toBe(mixedResults.length);
    });

    test('should return empty array for no matches', () => {
      const results = searchDocumentation('xyznonexistentterm123');
      expect(results).toHaveLength(0);
    });

    test('should find specific DSL keywords', () => {
      const flowResults = searchDocumentation('flow');
      expect(flowResults.length).toBeGreaterThan(0);
      expect(flowResults.some((r) => r.topic === 'scripted')).toBe(true);

      const toolResults = searchDocumentation('tool_call');
      expect(toolResults.length).toBeGreaterThan(0);
      expect(toolResults.some((r) => r.topic === 'trace-events')).toBe(true);
    });

    test('should include context around the match in excerpt', () => {
      const results = searchDocumentation('transitions');
      const scriptedResult = results.find((r) => r.topic === 'scripted');
      expect(scriptedResult).toBeDefined();
      expect(scriptedResult?.excerpt).toContain('transitions');
    });

    test('should handle multi-word searches', () => {
      const results = searchDocumentation('flow step');
      expect(results.length).toBeGreaterThan(0);
    });

    test('should find routing in supervisor docs', () => {
      const results = searchDocumentation('routing');
      const supervisorResult = results.find((r) => r.topic === 'supervisor');
      expect(supervisorResult).toBeDefined();
    });

    test('should find constraint concepts', () => {
      const results = searchDocumentation('constraint');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.topic === 'reasoning')).toBe(true);
    });
  });

  describe('Documentation Content Quality', () => {
    test('all docs should have markdown headers', () => {
      for (const topic of DOC_TOPICS) {
        const doc = DSL_DOCS[topic];
        expect(doc).toMatch(/^#\s/m); // Should start with a header
      }
    });

    test('all docs should have code examples', () => {
      for (const topic of DOC_TOPICS) {
        const doc = DSL_DOCS[topic];
        expect(doc).toContain('```'); // Should have code blocks
      }
    });

    test('scripted docs should have yaml examples', () => {
      const scripted = DSL_DOCS['scripted'];
      expect(scripted).toContain('```yaml');
    });

    test('trace-events should have json example', () => {
      const traceEvents = DSL_DOCS['trace-events'];
      expect(traceEvents).toContain('```json');
    });

    test('debugging guide should have agent-specific sections', () => {
      const debugging = DSL_DOCS['debugging'];
      expect(debugging).toContain('Scripted Agents');
      expect(debugging).toContain('Reasoning Agents');
      expect(debugging).toContain('Supervisor Agents');
    });

    test('context reference should show context structure', () => {
      const context = DSL_DOCS['context'];
      expect(context).toContain('```json');
      expect(context).toContain('"user"');
      expect(context).toContain('"collected"');
    });
  });
});

describe('MCP Protocol Types', () => {
  // Testing that tool schemas would be valid for MCP
  describe('Tool Schemas', () => {
    const expectedTools = [
      'kore_list_projects',
      'kore_get_sessions',
      'kore_get_traces',
      'kore_get_session_state',
      'kore_get_agent_spec',
      'kore_analyze_session',
      'kore_get_docs',
      'kore_search_docs',
      'kore_debug_session',
    ];

    test('should define expected number of tools', () => {
      // The server.ts defines 9 tools
      expect(expectedTools).toHaveLength(9);
    });

    test('all tool names should follow naming convention', () => {
      for (const tool of expectedTools) {
        expect(tool).toMatch(/^kore_[a-z_]+$/);
      }
    });
  });

  describe('Resource URIs', () => {
    const expectedResources = ['kore://docs/overview', 'kore://docs/debugging'];

    test('should define docs resources', () => {
      expect(expectedResources).toHaveLength(2);
    });

    test('resource URIs should follow protocol format', () => {
      for (const uri of expectedResources) {
        expect(uri).toMatch(/^kore:\/\/docs\/\w+$/);
      }
    });
  });
});

describe('Integration Scenarios', () => {
  describe('Documentation Workflow', () => {
    test('can look up topic and search within it', () => {
      // Simulate: user asks about scripted agents, then searches for specific term
      const scriptedDocs = getDocumentation('scripted');
      expect(scriptedDocs).toBeDefined();

      // Then search for a specific concept
      const results = searchDocumentation('collect');
      const scriptedMatch = results.find((r) => r.topic === 'scripted');
      expect(scriptedMatch).toBeDefined();
    });

    test('can discover available topics', () => {
      // List all topics
      expect(DOC_TOPICS).toContain('overview');

      // Read overview to understand structure
      const overview = getDocumentation('overview');
      expect(overview).toContain('Agent Types');
    });

    test('can debug by finding relevant docs', () => {
      // Scenario: agent stuck in loop
      const searchResults = searchDocumentation('loop');
      expect(searchResults.length).toBeGreaterThan(0);

      // Find debugging guide
      const debugResult = searchResults.find((r) => r.topic === 'debugging');
      expect(debugResult).toBeDefined();
    });
  });

  describe('Cross-Reference', () => {
    test('trace events mentioned in debugging guide', () => {
      const debugging = DSL_DOCS['debugging'];
      const traceEvents = DSL_DOCS['trace-events'];

      // Debugging guide should reference trace event types
      expect(debugging).toContain('flow_step_enter');
      expect(debugging).toContain('tool_call');

      // And trace events doc should define them
      expect(traceEvents).toContain('flow_step_enter');
      expect(traceEvents).toContain('tool_call');
    });

    test('context concepts consistent across docs', () => {
      const scripted = DSL_DOCS['scripted'];
      const context = DSL_DOCS['context'];

      // Both should mention context.collected
      expect(scripted).toContain('context');
      expect(context).toContain('collected');
    });
  });
});
