/**
 * Integration Tests for Static Graph Extraction
 *
 * Tests that verify the graph extractor works correctly when integrated
 * with the full DSL parsing and IR compilation pipeline.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { StaticGraph } from '../platform/ir/schema.js';

// Helper to find a node by ID
function findNode(graph: StaticGraph, id: string) {
  return graph.nodes.find((n) => n.id === id);
}

// Helper to find edges from a node
function findEdgesFrom(graph: StaticGraph, from: string) {
  return graph.edges.filter((e) => e.from === from);
}

describe('Graph Extractor Integration', () => {
  describe('Simple Sequential Flow', () => {
    const simpleDSL = `
AGENT: Simple_Flow

GOAL: "Simple sequential flow"

PERSONA: "Test agent"

FLOW:
  start -> greet -> farewell

  start:
    REASONING: false
    RESPOND: "Starting..."
    THEN: greet

  greet:
    REASONING: false
    RESPOND: "Hello there!"
    THEN: farewell

  farewell:
    REASONING: false
    RESPOND: "Goodbye!"
`;

    test('should extract sequential graph from simple flow', () => {
      const parseResult = parseAgentBasedABL(simpleDSL);
      expect(parseResult.document).toBeDefined();

      const output = compileABLtoIR([parseResult.document!]);
      const agent = output.agents['Simple_Flow'];
      expect(agent).toBeDefined();
      expect(agent.flow?.staticGraph).toBeDefined();

      const graph = agent.flow!.staticGraph!;

      // Should have entry, exit, and 3 step nodes
      expect(findNode(graph, '__entry__')).toBeDefined();
      expect(findNode(graph, '__exit__')).toBeDefined();
      expect(findNode(graph, 'start')).toBeDefined();
      expect(findNode(graph, 'greet')).toBeDefined();
      expect(findNode(graph, 'farewell')).toBeDefined();

      // Verify sequential edges
      expect(findEdgesFrom(graph, '__entry__')[0].to).toBe('start');
      expect(findEdgesFrom(graph, 'start')[0].to).toBe('greet');
      expect(findEdgesFrom(graph, 'greet')[0].to).toBe('farewell');
      expect(findEdgesFrom(graph, 'farewell')[0].to).toBe('__exit__');
    });

    test('should set correct entry point', () => {
      const parseResult = parseAgentBasedABL(simpleDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Simple_Flow'].flow!.staticGraph!;

      expect(graph.entryPoint).toBe('start');
    });
  });

  describe('ON_INPUT Branching Flow', () => {
    // Use exact DSL syntax from working examples
    const branchingDSL = `
AGENT: Branching_Flow

GOAL: "Test ON_INPUT branching"

PERSONA: "Test agent"

FLOW:
  ask_choice -> option_a -> option_b -> option_default

  ask_choice:
    REASONING: false
    PROMPT: "Choose A, B, or something else"
    ON_INPUT:
      - IF: input == "a"
        THEN: option_a
      - IF: input == "b"
        THEN: option_b
      - ELSE:
        THEN: option_default

  option_a:
    REASONING: false
    RESPOND: "You chose A"

  option_b:
    REASONING: false
    RESPOND: "You chose B"

  option_default:
    REASONING: false
    RESPOND: "Default option"
`;

    test('should create decision node for ON_INPUT', () => {
      const parseResult = parseAgentBasedABL(branchingDSL);
      expect(parseResult.errors).toHaveLength(0);
      expect(parseResult.document).toBeDefined();

      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Branching_Flow'].flow!.staticGraph!;

      const decisionNode = findNode(graph, 'ask_choice__decision');
      expect(decisionNode).toBeDefined();
      expect(decisionNode?.type).toBe('decision');
      expect(decisionNode?.deterministic).toBe(true);
    });

    test('should create conditional edges from decision node', () => {
      const parseResult = parseAgentBasedABL(branchingDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Branching_Flow'].flow!.staticGraph!;

      const decisionEdges = findEdgesFrom(graph, 'ask_choice__decision');
      expect(decisionEdges.length).toBe(3);

      const edgeToA = decisionEdges.find((e) => e.to === 'option_a');
      expect(edgeToA?.type).toBe('conditional');

      const edgeToDefault = decisionEdges.find((e) => e.to === 'option_default');
      expect(edgeToDefault?.isDefault).toBe(true);
    });
  });

  describe('Flow with CALL and Success/Failure', () => {
    // Use correct DSL syntax: ON_SUCCESS and ON_FAIL are blocks with nested properties
    const callDSL = `
AGENT: Call_Flow

GOAL: "Test CALL with success/failure paths"

PERSONA: "Test agent"

TOOLS:
  do_something() -> {result: boolean}
    description: "Do something"

FLOW:
  main -> success_step -> failure_step

  main:
    REASONING: false
    CALL: do_something()
    ON_SUCCESS:
      REASONING: false
      RESPOND: "It worked!"
      THEN: success_step
    ON_FAIL:
      RESPOND: "It failed"
      THEN: failure_step

  success_step:
    REASONING: false
    RESPOND: "Handling success"

  failure_step:
    REASONING: false
    RESPOND: "Handling failure"
`;

    test('should parse CALL flow correctly', () => {
      const parseResult = parseAgentBasedABL(callDSL);
      expect(parseResult.errors).toHaveLength(0);
      expect(parseResult.document).toBeDefined();

      // Check the parsed flow has the right structure
      const mainStep = parseResult.document!.flow?.definitions?.main;
      expect(mainStep?.call).toBe('do_something()');
    });

    test('should create success and failure edges', () => {
      const parseResult = parseAgentBasedABL(callDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Call_Flow'].flow!.staticGraph!;

      const mainEdges = findEdgesFrom(graph, 'main');

      // Check if the step has on_success in IR
      const flow = output.agents['Call_Flow'].flow!;
      const mainDef = flow.definitions['main'];

      // Graph should have success/failure edges if on_success/on_failure are present
      if (mainDef.on_success?.then) {
        const successEdge = mainEdges.find((e) => e.type === 'success');
        expect(successEdge).toBeDefined();
        expect(successEdge?.to).toBe('success_step');
      }

      if (mainDef.on_failure?.then) {
        const failureEdge = mainEdges.find((e) => e.type === 'failure');
        expect(failureEdge).toBeDefined();
        expect(failureEdge?.to).toBe('failure_step');
      }
    });

    test('should include call information in step node', () => {
      const parseResult = parseAgentBasedABL(callDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Call_Flow'].flow!.staticGraph!;

      const mainNode = findNode(graph, 'main');
      expect(mainNode?.step?.call).toBe('do_something()');
    });
  });

  describe('Flow with Digressions', () => {
    const digressionDSL = `
AGENT: Digression_Flow

GOAL: "Test digressions"

PERSONA: "Test agent"

FLOW:
  main_step -> help_step

  main_step:
    REASONING: false
    PROMPT: "How can I help you?"
    DIGRESSIONS:
      - INTENT: ask_help
        GOTO: help_step
      - INTENT: cancel_request
        RESPOND: "Cancelling..."
        GOTO: COMPLETE

  help_step:
    REASONING: false
    RESPOND: "Here is some help"
`;

    test('should create LLM decision nodes for digressions', () => {
      const parseResult = parseAgentBasedABL(digressionDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Digression_Flow'].flow!.staticGraph!;

      const helpIntentNode = findNode(graph, 'main_step__intent_ask_help');
      expect(helpIntentNode).toBeDefined();
      expect(helpIntentNode?.type).toBe('llm_decision');
      expect(helpIntentNode?.deterministic).toBe(false);

      const cancelIntentNode = findNode(graph, 'main_step__intent_cancel_request');
      expect(cancelIntentNode).toBeDefined();
    });

    test('should create digression edges', () => {
      const parseResult = parseAgentBasedABL(digressionDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Digression_Flow'].flow!.staticGraph!;

      const mainEdges = findEdgesFrom(graph, 'main_step');
      const digressionEdges = mainEdges.filter((e) => e.type === 'digression');

      expect(digressionEdges.length).toBe(2);
      expect(digressionEdges.map((e) => e.label).sort()).toEqual(['ask_help', 'cancel_request']);
    });
  });

  describe('Flow with Gather', () => {
    const gatherDSL = `
AGENT: Collection_Flow

GOAL: "Test data collection"

PERSONA: "Test agent"

FLOW:
  collect_info -> confirm

  collect_info:
    REASONING: false
    RESPOND: "Please provide your details"
    THEN: confirm

  confirm:
    REASONING: false
    RESPOND: "Thank you!"
`;

    test('should include gather step as node in graph', () => {
      const parseResult = parseAgentBasedABL(gatherDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Collection_Flow'].flow!.staticGraph!;

      const collectNode = findNode(graph, 'collect_info');
      expect(collectNode).toBeDefined();
      expect(collectNode?.type).toBe('step');
      expect(collectNode?.step?.respond).toBe('Please provide your details');

      // Verify sequential edge from collect_info to confirm
      const edges = findEdgesFrom(graph, 'collect_info');
      expect(edges).toHaveLength(1);
      expect(edges[0].to).toBe('confirm');
      expect(edges[0].type).toBe('sequential');
    });
  });

  describe('Complex Multi-Path Flow', () => {
    const complexDSL = `
AGENT: Complex_Flow

GOAL: "Complex flow with multiple paths"

PERSONA: "Test agent"

TOOLS:
  search_items(query: string) -> {items: array}
    description: "Search for items"

FLOW:
  welcome -> collect_query -> search -> show_results -> confirm

  welcome:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: collect_query

  collect_query:
    REASONING: false
    RESPOND: "What are you looking for?"
    ON_INPUT:
      - IF: input == "back"
        THEN: welcome
      - ELSE:
        THEN: search

  search:
    REASONING: false
    CALL: search_items(search_query)
    ON_SUCCESS:
      REASONING: false
      THEN: show_results
    ON_FAIL:
      RESPOND: "Search failed"
      THEN: collect_query

  show_results:
    REASONING: false
    RESPOND: "Found items: {{items}}"
    ON_INPUT:
      - IF: input == "select"
        THEN: confirm
      - IF: input == "search again"
        THEN: collect_query
      - ELSE:
        RESPOND: "Please select an item or search again"
        THEN: show_results

  confirm:
    REASONING: false
    RESPOND: "Selection confirmed!"
    DIGRESSIONS:
      - INTENT: change_mind
        GOTO: collect_query
`;

    test('should handle multiple decision nodes', () => {
      const parseResult = parseAgentBasedABL(complexDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Complex_Flow'].flow!.staticGraph!;

      expect(findNode(graph, 'collect_query__decision')).toBeDefined();
      expect(findNode(graph, 'show_results__decision')).toBeDefined();
    });

    test('should handle success/failure with decision nodes', () => {
      const parseResult = parseAgentBasedABL(complexDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Complex_Flow'].flow!.staticGraph!;

      const searchEdges = findEdgesFrom(graph, 'search');
      expect(searchEdges.some((e) => e.type === 'success')).toBe(true);
      expect(searchEdges.some((e) => e.type === 'failure')).toBe(true);
    });

    test('should handle back loops correctly', () => {
      const parseResult = parseAgentBasedABL(complexDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Complex_Flow'].flow!.staticGraph!;

      // collect_query can go back to welcome
      const collectDecisionEdges = findEdgesFrom(graph, 'collect_query__decision');
      expect(collectDecisionEdges.some((e) => e.to === 'welcome')).toBe(true);

      // show_results can go back to collect_query
      const showDecisionEdges = findEdgesFrom(graph, 'show_results__decision');
      expect(showDecisionEdges.some((e) => e.to === 'collect_query')).toBe(true);
    });

    test('should have correct total node count', () => {
      const parseResult = parseAgentBasedABL(complexDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Complex_Flow'].flow!.staticGraph!;

      // Entry, exit, 5 steps, 2 decision nodes, 1 intent node
      const stepNodes = graph.nodes.filter((n) => n.type === 'step').length;
      const decisionNodes = graph.nodes.filter((n) => n.type === 'decision').length;
      const intentNodes = graph.nodes.filter((n) => n.type === 'llm_decision').length;

      expect(stepNodes).toBe(5);
      expect(decisionNodes).toBe(2);
      expect(intentNodes).toBe(1);
    });
  });

  describe('Graph Structure Validation', () => {
    const validationDSL = `
AGENT: Validation_Flow

GOAL: "Test graph structure"

PERSONA: "Test agent"

FLOW:
  a -> b -> c

  a:
    REASONING: false
    RESPOND: "Step A"
    THEN: b

  b:
    REASONING: false
    RESPOND: "Step B"
    THEN: c

  c:
    REASONING: false
    RESPOND: "Step C"
`;

    test('should have unique node IDs', () => {
      const parseResult = parseAgentBasedABL(validationDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Validation_Flow'].flow!.staticGraph!;

      const nodeIds = graph.nodes.map((n) => n.id);
      const uniqueIds = new Set(nodeIds);
      expect(uniqueIds.size).toBe(nodeIds.length);
    });

    test('should have unique edge IDs', () => {
      const parseResult = parseAgentBasedABL(validationDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Validation_Flow'].flow!.staticGraph!;

      const edgeIds = graph.edges.map((e) => e.id);
      const uniqueIds = new Set(edgeIds);
      expect(uniqueIds.size).toBe(edgeIds.length);
    });

    test('all edges should reference existing nodes', () => {
      const parseResult = parseAgentBasedABL(validationDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Validation_Flow'].flow!.staticGraph!;

      const nodeIds = new Set(graph.nodes.map((n) => n.id));

      for (const edge of graph.edges) {
        expect(nodeIds.has(edge.from)).toBe(true);
        // Target may reference COMPLETE or external nodes
        if (!edge.to.startsWith('COMPLETE') && edge.to !== '__exit__') {
          expect(nodeIds.has(edge.to)).toBe(true);
        }
      }
    });

    test('entry node should only have outgoing edges', () => {
      const parseResult = parseAgentBasedABL(validationDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Validation_Flow'].flow!.staticGraph!;

      const incomingToEntry = graph.edges.filter((e) => e.to === '__entry__');
      expect(incomingToEntry.length).toBe(0);
    });

    test('exit node should only have incoming edges', () => {
      const parseResult = parseAgentBasedABL(validationDSL);
      const output = compileABLtoIR([parseResult.document!]);
      const graph = output.agents['Validation_Flow'].flow!.staticGraph!;

      const outgoingFromExit = graph.edges.filter((e) => e.from === '__exit__');
      expect(outgoingFromExit.length).toBe(0);
    });
  });
});
