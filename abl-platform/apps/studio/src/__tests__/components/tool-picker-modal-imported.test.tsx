/**
 * Tool Picker — Imported Tool Snippet Tests
 *
 * Tests the snippet generation for imported module tools,
 * which is used by both ToolPickerDialog and ToolPickerModal.
 */

import { describe, it, expect } from 'vitest';
import {
  buildImportedToolReferenceSnippet,
  buildMountedModuleToolName,
} from '../../components/abl/tool-snippets';

describe('imported tool snippet generation', () => {
  it('should build mounted module tool name with alias__name format', () => {
    expect(buildMountedModuleToolName('weather', 'get_forecast')).toBe('weather__get_forecast');
  });

  it('should build imported tool reference snippet with indentation', () => {
    const snippet = buildImportedToolReferenceSnippet('weather', 'get_forecast');
    expect(snippet).toBe('  weather__get_forecast()');
  });

  it('should handle single-char alias', () => {
    expect(buildMountedModuleToolName('a', 'tool')).toBe('a__tool');
  });

  it('should handle alias with underscores', () => {
    expect(buildMountedModuleToolName('my_module', 'my_tool')).toBe('my_module__my_tool');
  });

  it('should produce valid DSL tool reference format', () => {
    const snippet = buildImportedToolReferenceSnippet('benefits', 'check_coverage');
    // Should be indented (2 spaces) and have () for tool call
    expect(snippet).toMatch(/^\s+benefits__check_coverage\(\)$/);
  });
});
