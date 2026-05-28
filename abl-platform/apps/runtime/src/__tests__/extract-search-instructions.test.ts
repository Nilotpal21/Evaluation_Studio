import { describe, expect, test } from 'vitest';
import { extractSearchInstructionsFromDsl } from '../services/project-working-copy-compiler.js';

describe('extractSearchInstructionsFromDsl', () => {
  test('extracts inline quoted search_instructions (indented tool)', () => {
    const dsl = `AGENT: testcitations_1

PERSONA: |
    You are testcitations 1.

GOAL: "Help users with testcitations 1"

TOOLS:
    search_kb_scenario1(query: string, queryType?: string) -> {results: object[]}
    description: "Public API auto-config test"
    type: searchai
    search_instructions: "Detect the language of the user query and add a lang filter."`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    expect(result.get('search_kb_scenario1')).toBe(
      'Detect the language of the user query and add a lang filter.',
    );
  });

  test('extracts search_instructions when tool is at same indent as TOOLS: (indent 0)', () => {
    const dsl = `AGENT: testinstructions

PERSONA: |
  You are testinstructions.

GOAL: "Help users"

TOOLS:
search_kb_scenario3(query: string, queryType?: string) -> {results: object[]}
  description: "End-to-end test"
  type: searchai
  search_instructions: "Detect color from the query and add a color filter."`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    expect(result.get('search_kb_scenario3')).toBe(
      'Detect color from the query and add a color filter.',
    );
  });

  test('extracts pipe block search_instructions', () => {
    const dsl = `AGENT: test_agent

TOOLS:
    myTool(query: string) -> object
      type: searchai
      search_instructions: |
        Line one of instructions.
        Line two of instructions.
        Always add a lang filter.`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    expect(result.get('myTool')).toBe(
      'Line one of instructions.\nLine two of instructions.\nAlways add a lang filter.',
    );
  });

  test('extracts multiline quoted search_instructions (opening quote, continuation lines, closing quote)', () => {
    const dsl = `AGENT: testinstructions

TOOLS:
search_kb_test(query: string) -> {results: object[]}
  description: "Test KB"
  type: searchai
  search_instructions: "If the user mentions size (S, M, L, XL),
  add filter field 'size'. If the user mentions color,
  add filter field 'color'. Always add lang filter."`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    const value = result.get('search_kb_test');
    expect(value).toContain('If the user mentions size');
    expect(value).toContain("add filter field 'size'");
    expect(value).toContain('Always add lang filter.');
  });

  test('handles multiple tools — extracts search_instructions from each', () => {
    const dsl = `AGENT: multi_tool_agent

TOOLS:
    kb_products(query: string) -> object
      type: searchai
      search_instructions: "Always add a category filter."
    kb_support(query: string) -> object
      type: searchai
      search_instructions: "Always add a priority filter."`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(2);
    expect(result.get('kb_products')).toBe('Always add a category filter.');
    expect(result.get('kb_support')).toBe('Always add a priority filter.');
  });

  test('returns empty map when no TOOLS section', () => {
    const dsl = `AGENT: no_tools

PERSONA: |
  You are a simple agent.

GOAL: "Help users"`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(0);
  });

  test('returns empty map when tool has no search_instructions', () => {
    const dsl = `AGENT: no_instructions

TOOLS:
    myTool(query: string) -> object
      type: searchai
      description: "A tool without instructions"`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(0);
  });

  test('handles single-quoted search_instructions', () => {
    const dsl = `AGENT: test

TOOLS:
    myTool(query: string) -> object
      type: searchai
      search_instructions: 'Always filter by language.'`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    expect(result.get('myTool')).toBe('Always filter by language.');
  });

  test('stops TOOLS section at next top-level section', () => {
    const dsl = `AGENT: test

TOOLS:
    myTool(query: string) -> object
      type: searchai
      search_instructions: "Add lang filter."

FLOWS:
  main:
    START -> END`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    expect(result.get('myTool')).toBe('Add lang filter.');
  });

  test('real-world DSL with full tool signature and properties', () => {
    const dsl = `AGENT: testinstructions

PERSONA: |
  You are testinstructions.

GOAL: "Help users with testinstructions"

TOOLS:
search_kb_scenario3_e2e_test_dec70b11(query: string, queryType?: string, filters?: object[], aggregation?: {field: string, function?: string}, rerank?: boolean, skipPreprocessing?: boolean, skipVocabularyResolution?: boolean) -> {results: object[], totalCount: number, queryType: string, aggregations?: object[]}
  description: "End-to-end test of Scenario 3 field mapping fix"
  type: searchai
  index_id: "019e3c2c-ae7f-7778-b7ee-3ee315adb3fe"
  tenant_id: "tenant-dev-001"
  kb_name: "Scenario3-E2E-Test"
  search_instructions: "If the user mentions size (small, medium, large, XL, XXL, S, M,
  L, XL, XXL), add filter field 'size', operator 'equals', value as uppercase abbreviation (S, M,
  L, XL, XXL). If the query mentions men/man/boys/male, add filter field 'gender',
  operator 'equals', value 'men'. Always add lang filter with ISO 639-1 code."`;

    const result = extractSearchInstructionsFromDsl(dsl);
    expect(result.size).toBe(1);
    const value = result.get('search_kb_scenario3_e2e_test_dec70b11');
    expect(value).toBeDefined();
    expect(value).toContain('If the user mentions size');
    expect(value).toContain("add filter field 'gender'");
    expect(value).toContain('Always add lang filter with ISO 639-1 code.');
  });
});
