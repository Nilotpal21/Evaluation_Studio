/**
 * IntelligentInsertion — section routing & fallbacks
 *
 * Guards the Insert Tool Signature flow for imported module tools (ABLP-51).
 * Regression coverage for: snippets that arrive without a populated commandId
 * (e.g. the toolbar-launched legacy Tool Picker) must still route to the
 * TOOLS: section, not land at line 1 before AGENT:.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insertSnippetIntelligently } from '../../components/abl/commands/IntelligentInsertion';

// ─── Minimal in-memory Monaco model stub ──────────────────────────────────

interface Edit {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
}

function createFakeEditor(initialContent: string, cursorLine = 1) {
  const lines = initialContent.split('\n');
  const appliedEdits: Edit[] = [];

  const model = {
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
  };

  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: cursorLine, column: 1 }),
    setPosition: vi.fn(),
    revealLineInCenter: vi.fn(),
    executeEdits: (_source: string, edits: Edit[]) => {
      for (const edit of edits) {
        appliedEdits.push(edit);
        // Apply the edit to our in-memory lines so finalText reflects reality.
        const startIdx = edit.range.startLineNumber - 1;
        const endIdx = edit.range.endLineNumber - 1;
        const before = lines.slice(0, startIdx);
        const after = lines.slice(endIdx + 1);
        const startLine = lines[startIdx] ?? '';
        const endLine = lines[endIdx] ?? '';
        const prefix = startLine.slice(0, edit.range.startColumn - 1);
        const suffix = endLine.slice(edit.range.endColumn - 1);
        const merged = (prefix + edit.text + suffix).split('\n');
        lines.length = 0;
        lines.push(...before, ...merged, ...after);
      }
      return true;
    },
  };

  return {
    editor: editor as unknown as Parameters<typeof insertSnippetIntelligently>[0],
    appliedEdits,
    finalText: () => lines.join('\n'),
  };
}

const AGENT_NO_TOOLS = `AGENT: helper
VERSION: 1
GOAL: assist users
PERSONA: friendly`;

const AGENT_WITH_TOOLS = `AGENT: helper
VERSION: 1
GOAL: assist users
TOOLS:
  existing_tool()
GOAL: assist users`;

// Imported module tool reference — exactly what
// `buildImportedToolReferenceSnippet(alias, name)` produces.
const IMPORTED_TOOL_SNIPPET = '  demo__charge_card()';

describe('IntelligentInsertion — tool routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates TOOLS: section when commandId is "tool" and section is missing', () => {
    const { editor, finalText } = createFakeEditor(AGENT_NO_TOOLS);

    const result = insertSnippetIntelligently(editor, IMPORTED_TOOL_SNIPPET, 'tool', 'root');

    expect(result.success).toBe(true);
    expect(finalText()).toContain('TOOLS:');
    expect(finalText()).toContain('demo__charge_card()');
    // Tool reference must appear AFTER AGENT:, never before it.
    const agentIdx = finalText().indexOf('AGENT:');
    const toolIdx = finalText().indexOf('demo__charge_card()');
    expect(agentIdx).toBeLessThan(toolIdx);
  });

  it('appends into existing TOOLS: section when commandId is "tool"', () => {
    const { editor, finalText } = createFakeEditor(AGENT_WITH_TOOLS);

    const result = insertSnippetIntelligently(editor, IMPORTED_TOOL_SNIPPET, 'tool', 'root');

    expect(result.success).toBe(true);
    expect(finalText()).toContain('existing_tool()');
    expect(finalText()).toContain('demo__charge_card()');
    // Should NOT introduce a duplicate TOOLS: header.
    const matches = finalText().match(/TOOLS:/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('REGRESSION: empty commandId + tool-shaped snippet still routes to TOOLS:', () => {
    // This is the exact ABLP-51 bug: toolbar Wrench button opens the legacy
    // ToolPickerDialog without stamping lastCommandId, so handleToolInsert
    // forwarded `''` and the snippet landed at cursor line 1 before AGENT:.
    const { editor, finalText } = createFakeEditor(AGENT_NO_TOOLS, /* cursorLine */ 1);

    const result = insertSnippetIntelligently(editor, IMPORTED_TOOL_SNIPPET, '', 'root');

    expect(result.success).toBe(true);
    // Section was inferred and created (or appended-to), NOT a cursor-line dump.
    expect(finalText()).toContain('TOOLS:');
    const agentIdx = finalText().indexOf('AGENT:');
    const toolIdx = finalText().indexOf('demo__charge_card()');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(agentIdx);
    // The tool reference must NOT appear before AGENT:.
    expect(finalText().startsWith('  demo__charge_card()')).toBe(false);
  });

  it('REGRESSION: unrecognized commandId + tool-shaped snippet still routes to TOOLS:', () => {
    const { editor, finalText } = createFakeEditor(AGENT_NO_TOOLS);

    const result = insertSnippetIntelligently(
      editor,
      IMPORTED_TOOL_SNIPPET,
      'totally-unknown-command-id',
      'root',
    );

    expect(result.success).toBe(true);
    expect(finalText()).toContain('TOOLS:');
    expect(finalText()).toContain('demo__charge_card()');
  });

  it('full signature snippet (with description + type) also routes to TOOLS:', () => {
    // What `buildToolSignatureSnippet` produces for a project-local tool.
    const sigSnippet = `  charge_card(amount: number) -> Result
    description: "Charges a card"
    type: http`;
    const { editor, finalText } = createFakeEditor(AGENT_NO_TOOLS);

    const result = insertSnippetIntelligently(editor, sigSnippet, '', 'root');

    expect(result.success).toBe(true);
    expect(finalText()).toContain('TOOLS:');
    expect(finalText()).toContain('charge_card(amount: number)');
    expect(finalText()).toContain('type: http');
  });

  it('non-tool snippet with no commandId still falls back to cursor insert', () => {
    // e.g. a free-form note that is not tool-shaped — preserves existing
    // behavior so we don't accidentally over-route other constructs.
    const noteSnippet = '# just a comment line';
    const { editor, finalText } = createFakeEditor(AGENT_NO_TOOLS, /* cursorLine */ 2);

    const result = insertSnippetIntelligently(editor, noteSnippet, '', 'root');

    expect(result.success).toBe(true);
    // No TOOLS: section was synthesized.
    expect(finalText()).not.toContain('TOOLS:');
  });
});
