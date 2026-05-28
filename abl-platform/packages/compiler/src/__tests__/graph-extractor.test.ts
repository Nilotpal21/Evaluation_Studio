/**
 * Tests for Static Graph Extractor
 *
 * Tests the extraction of static execution graphs from FlowConfig for state machine visualization.
 */

import { describe, test, expect } from 'vitest';
import { extractStaticGraph } from '../platform/ir/graph-extractor.js';
import type {
  FlowConfig,
  StaticGraph,
  StaticGraphNode,
  StaticGraphEdge,
} from '../platform/ir/schema.js';

// Helper to create a minimal FlowConfig
function createFlowConfig(
  steps: string[],
  definitions: FlowConfig['definitions'],
  options: Partial<FlowConfig> = {},
): FlowConfig {
  return {
    steps,
    definitions,
    ...options,
  };
}

// Helper to find a node by ID
function findNode(graph: StaticGraph, id: string): StaticGraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

// Helper to find edges from a node
function findEdgesFrom(graph: StaticGraph, from: string): StaticGraphEdge[] {
  return graph.edges.filter((e) => e.from === from);
}

// Helper to find edges to a node
function findEdgesTo(graph: StaticGraph, to: string): StaticGraphEdge[] {
  return graph.edges.filter((e) => e.to === to);
}

describe('extractStaticGraph', () => {
  describe('Basic Structure', () => {
    test('should create entry node for any flow', () => {
      const flowConfig = createFlowConfig(['step1'], {
        step1: { name: 'step1', respond: 'Hello' },
      });

      const graph = extractStaticGraph(flowConfig);

      const entryNode = findNode(graph, '__entry__');
      expect(entryNode).toBeDefined();
      expect(entryNode?.type).toBe('entry');
      expect(entryNode?.label).toBe('Start');
      expect(entryNode?.deterministic).toBe(true);
    });

    test('should create edge from entry to first step', () => {
      const flowConfig = createFlowConfig(['greeting'], {
        greeting: { name: 'greeting', respond: 'Hello!' },
      });

      const graph = extractStaticGraph(flowConfig);

      const entryEdges = findEdgesFrom(graph, '__entry__');
      expect(entryEdges).toHaveLength(1);
      expect(entryEdges[0].to).toBe('greeting');
      expect(entryEdges[0].type).toBe('sequential');
    });

    test('should use custom entry_point when specified', () => {
      const flowConfig = createFlowConfig(
        ['step1', 'step2', 'step3'],
        {
          step1: { name: 'step1', then: 'step2' },
          step2: { name: 'step2', then: 'step3' },
          step3: { name: 'step3', respond: 'Done' },
        },
        { entry_point: 'step2' },
      );

      const graph = extractStaticGraph(flowConfig);

      expect(graph.entryPoint).toBe('step2');
      const entryEdges = findEdgesFrom(graph, '__entry__');
      expect(entryEdges[0].to).toBe('step2');
    });

    test('should create exit node for terminal steps', () => {
      const flowConfig = createFlowConfig(['step1'], {
        step1: { name: 'step1', respond: 'Goodbye' },
      });

      const graph = extractStaticGraph(flowConfig);

      const exitNode = findNode(graph, '__exit__');
      expect(exitNode).toBeDefined();
      expect(exitNode?.type).toBe('exit');
      expect(exitNode?.label).toBe('End');
    });

    test('should connect terminal steps to exit node', () => {
      const flowConfig = createFlowConfig(['step1', 'step2'], {
        step1: { name: 'step1', then: 'step2' },
        step2: { name: 'step2', respond: 'Done' },
      });

      const graph = extractStaticGraph(flowConfig);

      const exitEdges = findEdgesTo(graph, '__exit__');
      expect(exitEdges).toHaveLength(1);
      expect(exitEdges[0].from).toBe('step2');
      expect(exitEdges[0].label).toBe('complete');
    });
  });

  describe('Step Nodes', () => {
    test('should create step nodes for all steps', () => {
      const flowConfig = createFlowConfig(['welcome', 'gather_info', 'farewell'], {
        welcome: { name: 'welcome', respond: 'Welcome!', then: 'gather_info' },
        gather_info: { name: 'gather_info', call: 'lookup_info', then: 'farewell' },
        farewell: { name: 'farewell', respond: 'Goodbye!' },
      });

      const graph = extractStaticGraph(flowConfig);

      const welcomeNode = findNode(graph, 'welcome');
      expect(welcomeNode).toBeDefined();
      expect(welcomeNode?.type).toBe('step');
      expect(welcomeNode?.label).toBe('welcome');

      const gatherNode = findNode(graph, 'gather_info');
      expect(gatherNode).toBeDefined();
      expect(gatherNode?.step?.call).toBe('lookup_info');

      const farewellNode = findNode(graph, 'farewell');
      expect(farewellNode).toBeDefined();
      expect(farewellNode?.step?.respond).toBe('Goodbye!');
    });

    test('should include step details (call, respond, check)', () => {
      const flowConfig = createFlowConfig(['step1'], {
        step1: {
          name: 'step1',
          call: 'process_data',
          check: 'pre_validation',
          respond: 'Processing complete',
        },
      });

      const graph = extractStaticGraph(flowConfig);
      const stepNode = findNode(graph, 'step1');

      expect(stepNode?.step).toEqual({
        call: 'process_data',
        check: 'pre_validation',
        respond: 'Processing complete',
      });
    });
  });

  describe('Sequential Transitions (THEN)', () => {
    test('should create sequential edges for THEN transitions', () => {
      const flowConfig = createFlowConfig(['step1', 'step2', 'step3'], {
        step1: { name: 'step1', then: 'step2' },
        step2: { name: 'step2', then: 'step3' },
        step3: { name: 'step3', respond: 'Done' },
      });

      const graph = extractStaticGraph(flowConfig);

      const step1Edges = findEdgesFrom(graph, 'step1');
      expect(step1Edges).toHaveLength(1);
      expect(step1Edges[0].to).toBe('step2');
      expect(step1Edges[0].type).toBe('sequential');

      const step2Edges = findEdgesFrom(graph, 'step2');
      expect(step2Edges).toHaveLength(1);
      expect(step2Edges[0].to).toBe('step3');
    });

    test('should handle linear flow correctly', () => {
      const flowConfig = createFlowConfig(['a', 'b', 'c', 'd'], {
        a: { name: 'a', then: 'b' },
        b: { name: 'b', then: 'c' },
        c: { name: 'c', then: 'd' },
        d: { name: 'd', respond: 'Complete' },
      });

      const graph = extractStaticGraph(flowConfig);

      // Verify the chain
      expect(findEdgesFrom(graph, 'a')[0].to).toBe('b');
      expect(findEdgesFrom(graph, 'b')[0].to).toBe('c');
      expect(findEdgesFrom(graph, 'c')[0].to).toBe('d');
      expect(findEdgesFrom(graph, 'd')[0]?.to).toBe('__exit__');
    });
  });

  describe('Conditional Branching (ON_INPUT)', () => {
    test('should create decision node for ON_INPUT', () => {
      const flowConfig = createFlowConfig(['ask_choice', 'option_a', 'option_b'], {
        ask_choice: {
          name: 'ask_choice',
          prompt: 'Choose A or B',
          on_input: [
            { condition: 'input contains "a"', then: 'option_a' },
            { condition: 'input contains "b"', then: 'option_b' },
          ],
        },
        option_a: { name: 'option_a', respond: 'You chose A' },
        option_b: { name: 'option_b', respond: 'You chose B' },
      });

      const graph = extractStaticGraph(flowConfig);

      const decisionNode = findNode(graph, 'ask_choice__decision');
      expect(decisionNode).toBeDefined();
      expect(decisionNode?.type).toBe('decision');
      expect(decisionNode?.label).toBe('ON_INPUT');
      expect(decisionNode?.deterministic).toBe(true);
      expect(decisionNode?.conditions).toContain('input contains "a"');
      expect(decisionNode?.conditions).toContain('input contains "b"');
    });

    test('should create edge from step to decision node', () => {
      const flowConfig = createFlowConfig(['ask', 'yes', 'no'], {
        ask: {
          name: 'ask',
          on_input: [
            { condition: 'yes', then: 'yes' },
            { then: 'no' }, // ELSE branch
          ],
        },
        yes: { name: 'yes', respond: 'Great!' },
        no: { name: 'no', respond: 'Maybe next time' },
      });

      const graph = extractStaticGraph(flowConfig);

      const askEdges = findEdgesFrom(graph, 'ask');
      expect(askEdges).toHaveLength(1);
      expect(askEdges[0].to).toBe('ask__decision');
      expect(askEdges[0].type).toBe('sequential');
    });

    test('should create conditional edges from decision to targets', () => {
      const flowConfig = createFlowConfig(['menu', 'flights', 'hotels', 'cars'], {
        menu: {
          name: 'menu',
          on_input: [
            { condition: 'flight', then: 'flights' },
            { condition: 'hotel', then: 'hotels' },
            { then: 'cars' }, // default
          ],
        },
        flights: { name: 'flights', respond: 'Flight options' },
        hotels: { name: 'hotels', respond: 'Hotel options' },
        cars: { name: 'cars', respond: 'Car options' },
      });

      const graph = extractStaticGraph(flowConfig);

      const decisionEdges = findEdgesFrom(graph, 'menu__decision');
      expect(decisionEdges).toHaveLength(3);

      const flightEdge = decisionEdges.find((e) => e.to === 'flights');
      expect(flightEdge?.type).toBe('conditional');
      expect(flightEdge?.label).toBe('flight');
      expect(flightEdge?.isDefault).toBeFalsy();

      const carsEdge = decisionEdges.find((e) => e.to === 'cars');
      expect(carsEdge?.type).toBe('conditional');
      expect(carsEdge?.label).toBe('ELSE');
      expect(carsEdge?.isDefault).toBe(true);
    });

    test('should handle decision node conditions list', () => {
      const flowConfig = createFlowConfig(['choice', 'a', 'b', 'c'], {
        choice: {
          name: 'choice',
          on_input: [
            { condition: 'condition_a', then: 'a' },
            { condition: 'condition_b', then: 'b' },
            { then: 'c' },
          ],
        },
        a: { name: 'a', respond: 'A' },
        b: { name: 'b', respond: 'B' },
        c: { name: 'c', respond: 'C' },
      });

      const graph = extractStaticGraph(flowConfig);
      const decisionNode = findNode(graph, 'choice__decision');

      expect(decisionNode?.conditions).toEqual(['condition_a', 'condition_b', 'ELSE']);
    });
  });

  describe('Call Success/Failure Paths', () => {
    test('should create success edge for ON_SUCCESS', () => {
      const flowConfig = createFlowConfig(['search', 'show_results', 'show_error'], {
        search: {
          name: 'search',
          call: 'search_api',
          on_success: { respond: 'Found results', then: 'show_results' },
          on_failure: { respond: 'Search failed', then: 'show_error' },
        },
        show_results: { name: 'show_results', respond: 'Here are your results' },
        show_error: { name: 'show_error', respond: 'Please try again' },
      });

      const graph = extractStaticGraph(flowConfig);

      const searchEdges = findEdgesFrom(graph, 'search');
      const successEdge = searchEdges.find((e) => e.type === 'success');
      expect(successEdge).toBeDefined();
      expect(successEdge?.to).toBe('show_results');
      expect(successEdge?.label).toBe('success');
    });

    test('should create failure edge for ON_FAILURE', () => {
      const flowConfig = createFlowConfig(['api_call', 'success_step', 'failure_step'], {
        api_call: {
          name: 'api_call',
          call: 'external_api',
          on_success: { then: 'success_step' },
          on_failure: { then: 'failure_step' },
        },
        success_step: { name: 'success_step', respond: 'Success!' },
        failure_step: { name: 'failure_step', respond: 'Failed' },
      });

      const graph = extractStaticGraph(flowConfig);

      const apiEdges = findEdgesFrom(graph, 'api_call');
      const failureEdge = apiEdges.find((e) => e.type === 'failure');
      expect(failureEdge).toBeDefined();
      expect(failureEdge?.to).toBe('failure_step');
      expect(failureEdge?.label).toBe('failure');
    });

    test('should create both success and failure edges', () => {
      const flowConfig = createFlowConfig(['process', 'done', 'error'], {
        process: {
          name: 'process',
          call: 'process_order',
          on_success: { then: 'done' },
          on_failure: { then: 'error' },
        },
        done: { name: 'done', respond: 'Order processed' },
        error: { name: 'error', respond: 'Processing failed' },
      });

      const graph = extractStaticGraph(flowConfig);

      const processEdges = findEdgesFrom(graph, 'process');
      expect(processEdges.filter((e) => e.type === 'success')).toHaveLength(1);
      expect(processEdges.filter((e) => e.type === 'failure')).toHaveLength(1);
    });
  });

  describe('Simple Error Handling (ON_FAIL)', () => {
    test('should create error edge for ON_FAIL', () => {
      const flowConfig = createFlowConfig(['risky_step', 'recovery'], {
        risky_step: {
          name: 'risky_step',
          call: 'risky_operation',
          on_fail: 'recovery',
          then: 'success_step',
        },
        recovery: { name: 'recovery', respond: 'Recovering...' },
        success_step: { name: 'success_step', respond: 'Done' },
      });

      const graph = extractStaticGraph(flowConfig);

      const riskyEdges = findEdgesFrom(graph, 'risky_step');
      const errorEdge = riskyEdges.find((e) => e.type === 'error');
      expect(errorEdge).toBeDefined();
      expect(errorEdge?.to).toBe('recovery');
      expect(errorEdge?.label).toBe('error');
    });
  });

  describe('Digressions', () => {
    test('should create LLM decision node for step-level digression', () => {
      const flowConfig = createFlowConfig(['main_step', 'help_step'], {
        main_step: {
          name: 'main_step',
          prompt: 'How can I help?',
          digressions: [{ intent: 'ask_help', goto: 'help_step' }],
        },
        help_step: { name: 'help_step', respond: 'Here is some help' },
      });

      const graph = extractStaticGraph(flowConfig);

      const intentNode = findNode(graph, 'main_step__intent_ask_help');
      expect(intentNode).toBeDefined();
      expect(intentNode?.type).toBe('llm_decision');
      expect(intentNode?.label).toBe('Intent: ask_help');
      expect(intentNode?.deterministic).toBe(false);
      expect(intentNode?.conditions).toContain('ask_help');
    });

    test('should create digression edge to intent node', () => {
      const flowConfig = createFlowConfig(['booking', 'cancel_flow'], {
        booking: {
          name: 'booking',
          digressions: [{ intent: 'cancel', goto: 'cancel_flow' }],
        },
        cancel_flow: { name: 'cancel_flow', respond: 'Booking cancelled' },
      });

      const graph = extractStaticGraph(flowConfig);

      const bookingEdges = findEdgesFrom(graph, 'booking');
      const digressionEdge = bookingEdges.find((e) => e.type === 'digression');
      expect(digressionEdge).toBeDefined();
      expect(digressionEdge?.to).toBe('booking__intent_cancel');
      expect(digressionEdge?.label).toBe('cancel');
    });

    test('should create edge from intent node to target step', () => {
      const flowConfig = createFlowConfig(['step1', 'faq_step'], {
        step1: {
          name: 'step1',
          digressions: [{ intent: 'faq', goto: 'faq_step' }],
        },
        faq_step: { name: 'faq_step', respond: 'FAQ information' },
      });

      const graph = extractStaticGraph(flowConfig);

      const intentNode = 'step1__intent_faq';
      const intentEdges = findEdgesFrom(graph, intentNode);
      expect(intentEdges).toHaveLength(1);
      expect(intentEdges[0].to).toBe('faq_step');
      expect(intentEdges[0].type).toBe('sequential');
    });

    test('should handle digression with resume flag', () => {
      const flowConfig = createFlowConfig(['main', 'weather'], {
        main: {
          name: 'main',
          digressions: [{ intent: 'weather_check', goto: 'weather', resume: true }],
        },
        weather: { name: 'weather', respond: 'Weather info' },
      });

      const graph = extractStaticGraph(flowConfig);

      const intentEdges = findEdgesFrom(graph, 'main__intent_weather_check');
      expect(intentEdges[0].label).toBe('with resume');
    });

    test('should handle digression with delegate', () => {
      const flowConfig = createFlowConfig(['main'], {
        main: {
          name: 'main',
          digressions: [{ intent: 'specialist_query', delegate: 'specialist_agent' }],
        },
      });

      const graph = extractStaticGraph(flowConfig);

      const intentNode = 'main__intent_specialist_query';
      const delegateNodeId = `${intentNode}__delegate_specialist_agent`;

      const delegateNode = findNode(graph, delegateNodeId);
      expect(delegateNode).toBeDefined();
      expect(delegateNode?.type).toBe('step');
      expect(delegateNode?.label).toBe('Delegate: specialist_agent');

      const intentEdges = findEdgesFrom(graph, intentNode);
      const delegateEdge = intentEdges.find((e) => e.to === delegateNodeId);
      expect(delegateEdge).toBeDefined();
      expect(delegateEdge?.label).toBe('delegate');
    });
  });

  describe('Global Digressions', () => {
    test('should process global digressions', () => {
      const flowConfig = createFlowConfig(
        ['step1', 'step2', 'help'],
        {
          step1: { name: 'step1', then: 'step2' },
          step2: { name: 'step2', respond: 'Done' },
          help: { name: 'help', respond: 'Help info' },
        },
        {
          global_digressions: [{ intent: 'help_request', goto: 'help' }],
        },
      );

      const graph = extractStaticGraph(flowConfig);

      const globalIntentNode = findNode(graph, '__global____intent_help_request');
      expect(globalIntentNode).toBeDefined();
      expect(globalIntentNode?.type).toBe('llm_decision');
    });

    test('should connect global digressions from entry node', () => {
      const flowConfig = createFlowConfig(
        ['main', 'emergency'],
        {
          main: { name: 'main', respond: 'Main flow' },
          emergency: { name: 'emergency', respond: 'Emergency handling' },
        },
        {
          global_digressions: [{ intent: 'emergency', goto: 'emergency' }],
        },
      );

      const graph = extractStaticGraph(flowConfig);

      // Global digressions should connect from __entry__
      const entryEdges = findEdgesFrom(graph, '__entry__');
      const emergencyDigression = entryEdges.find((e) => e.type === 'digression');
      expect(emergencyDigression).toBeDefined();
      expect(emergencyDigression?.label).toBe('emergency');
    });
  });

  describe('Terminal Step Detection', () => {
    test('should identify step with no THEN as terminal', () => {
      const flowConfig = createFlowConfig(['step1'], {
        step1: { name: 'step1', respond: 'Final response' },
      });

      const graph = extractStaticGraph(flowConfig);

      expect(findNode(graph, '__exit__')).toBeDefined();
      expect(findEdgesFrom(graph, 'step1').some((e) => e.to === '__exit__')).toBe(true);
    });

    test('should not create exit for steps with ON_INPUT', () => {
      const flowConfig = createFlowConfig(['step1', 'step2'], {
        step1: {
          name: 'step1',
          on_input: [{ then: 'step2' }],
        },
        step2: { name: 'step2', respond: 'Done' },
      });

      const graph = extractStaticGraph(flowConfig);

      // step1 is not terminal because it has on_input
      const step1ToExit = findEdgesFrom(graph, 'step1').find((e) => e.to === '__exit__');
      expect(step1ToExit).toBeUndefined();
    });

    test('should not create exit node if no terminal steps exist', () => {
      // Create a circular flow (unrealistic but tests the logic)
      const flowConfig = createFlowConfig(['step1', 'step2'], {
        step1: { name: 'step1', then: 'step2' },
        step2: { name: 'step2', then: 'step1' },
      });

      const graph = extractStaticGraph(flowConfig);

      expect(findNode(graph, '__exit__')).toBeUndefined();
    });

    test('should handle multiple terminal steps', () => {
      const flowConfig = createFlowConfig(['start', 'end_success', 'end_failure'], {
        start: {
          name: 'start',
          call: 'check',
          on_success: { then: 'end_success' },
          on_failure: { then: 'end_failure' },
        },
        end_success: { name: 'end_success', respond: 'Success!' },
        end_failure: { name: 'end_failure', respond: 'Failed!' },
      });

      const graph = extractStaticGraph(flowConfig);

      const exitEdges = findEdgesTo(graph, '__exit__');
      expect(exitEdges).toHaveLength(2);
      expect(exitEdges.map((e) => e.from).sort()).toEqual(['end_failure', 'end_success']);
    });
  });

  describe('Node Deduplication', () => {
    test('should not create duplicate nodes for same step', () => {
      const flowConfig = createFlowConfig(['choice', 'shared', 'a', 'b'], {
        choice: {
          name: 'choice',
          on_input: [
            { condition: 'a', then: 'shared' },
            { condition: 'b', then: 'shared' },
          ],
        },
        shared: { name: 'shared', respond: 'Shared step' },
        a: { name: 'a', respond: 'A' },
        b: { name: 'b', respond: 'B' },
      });

      const graph = extractStaticGraph(flowConfig);

      const sharedNodes = graph.nodes.filter((n) => n.id === 'shared');
      expect(sharedNodes).toHaveLength(1);
    });
  });

  describe('Complex Flows', () => {
    test('should handle a complete booking flow', () => {
      const flowConfig = createFlowConfig(
        ['welcome', 'collect_dates', 'search', 'show_results', 'confirm', 'farewell'],
        {
          welcome: { name: 'welcome', prompt: 'Welcome!', then: 'collect_dates' },
          collect_dates: {
            name: 'collect_dates',
            respond: 'Enter dates',
            then: 'search',
          },
          search: {
            name: 'search',
            call: 'search_hotels',
            on_success: { then: 'show_results' },
            on_failure: { respond: 'Search failed', then: 'collect_dates' },
          },
          show_results: {
            name: 'show_results',
            respond: 'Here are results',
            on_input: [
              { condition: 'book', then: 'confirm' },
              { condition: 'search again', then: 'collect_dates' },
              { then: 'farewell' },
            ],
          },
          confirm: {
            name: 'confirm',
            call: 'create_booking',
            then: 'farewell',
            digressions: [{ intent: 'cancel', goto: 'farewell' }],
          },
          farewell: { name: 'farewell', respond: 'Goodbye!' },
        },
      );

      const graph = extractStaticGraph(flowConfig);

      // Verify structure
      expect(findNode(graph, '__entry__')).toBeDefined();
      expect(findNode(graph, '__exit__')).toBeDefined();

      // All steps should be nodes
      const stepNames = [
        'welcome',
        'collect_dates',
        'search',
        'show_results',
        'confirm',
        'farewell',
      ];
      for (const step of stepNames) {
        expect(findNode(graph, step)).toBeDefined();
      }

      // Decision node for show_results
      expect(findNode(graph, 'show_results__decision')).toBeDefined();

      // Intent node for confirm's digression
      expect(findNode(graph, 'confirm__intent_cancel')).toBeDefined();

      // Verify entry
      expect(graph.entryPoint).toBe('welcome');

      // Verify some key edges
      expect(findEdgesFrom(graph, 'search').some((e) => e.type === 'success')).toBe(true);
      expect(findEdgesFrom(graph, 'search').some((e) => e.type === 'failure')).toBe(true);
    });

    test('should handle flow with multiple digressions', () => {
      const flowConfig = createFlowConfig(['main', 'help', 'cancel', 'agent'], {
        main: {
          name: 'main',
          prompt: 'What can I help with?',
          digressions: [
            { intent: 'help', goto: 'help', resume: true },
            { intent: 'cancel', goto: 'cancel' },
            { intent: 'human', delegate: 'human_agent' },
          ],
        },
        help: { name: 'help', respond: 'Help info' },
        cancel: { name: 'cancel', respond: 'Cancelled' },
        agent: { name: 'agent', respond: 'Connecting...' },
      });

      const graph = extractStaticGraph(flowConfig);

      // Three intent nodes
      expect(findNode(graph, 'main__intent_help')).toBeDefined();
      expect(findNode(graph, 'main__intent_cancel')).toBeDefined();
      expect(findNode(graph, 'main__intent_human')).toBeDefined();

      // Delegate node
      expect(findNode(graph, 'main__intent_human__delegate_human_agent')).toBeDefined();

      // Three digression edges from main
      const mainDigressions = findEdgesFrom(graph, 'main').filter((e) => e.type === 'digression');
      expect(mainDigressions).toHaveLength(3);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty flow gracefully', () => {
      const flowConfig = createFlowConfig([], {});

      const graph = extractStaticGraph(flowConfig);

      expect(graph.nodes).toHaveLength(1); // Just entry
      expect(findNode(graph, '__entry__')).toBeDefined();
    });

    test('should handle step with missing definition', () => {
      const flowConfig = createFlowConfig(['step1', 'undefined_step'], {
        step1: { name: 'step1', then: 'undefined_step' },
      });

      // Should not throw
      const graph = extractStaticGraph(flowConfig);
      expect(graph).toBeDefined();
    });

    test('should handle ON_INPUT with missing target definition', () => {
      const flowConfig = createFlowConfig(['step1'], {
        step1: {
          name: 'step1',
          on_input: [{ condition: 'yes', then: 'missing_step' }],
        },
      });

      // Should not throw
      const graph = extractStaticGraph(flowConfig);
      expect(graph).toBeDefined();

      const decisionEdges = findEdgesFrom(graph, 'step1__decision');
      expect(decisionEdges[0].to).toBe('missing_step');
    });
  });
});
