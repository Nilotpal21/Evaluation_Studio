# ABL DSL Inline Editing Experience — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add context-aware slash commands to the ABL Monaco editor that open visual pickers for inserting DSL constructs with live YAML preview.

**Architecture:** Monaco editor detects cursor position in DSL via AST parsing, shows context-filtered command palette on `/` keypress, opens picker modals for the selected construct, generates indent-aware YAML snippets, and inserts at cursor. All pickers share a `BasePickerModal` component with search, tabs, keyboard navigation, and preview split.

**Tech Stack:** React 18, Next.js App Router, Monaco Editor (`@monaco-editor/react`), Zustand, `@abl/core` (parser), `@abl/language-service`, `@abl/compiler` (builtin templates), Radix UI, Framer Motion, next-intl, Vitest, Tailwind CSS.

**Branch:** `feature/ABLP-47-DSL-Editor`
**Ticket:** ABLP-47

---

## File Structure

### New Files

```
apps/studio/src/components/abl/
├── commands/
│   ├── DSLContextDetector.ts          — AST-based section detection at cursor
│   ├── DSLContextDetector.test.ts     — Unit tests for context detection
│   ├── CommandRegistry.ts             — 35+ commands with section mapping
│   ├── CommandRegistry.test.ts        — Unit tests for command filtering
│   ├── SnippetGenerator.ts            — Indent-aware YAML generation
│   ├── SnippetGenerator.test.ts       — Unit tests for snippet generation
│   ├── useMonacoCommands.ts           — Hook: "/" trigger + keyboard shortcuts
│   └── CommandPaletteWidget.tsx        — Inline palette positioned at cursor
├── pickers/
│   ├── BasePickerModal.tsx            — Shared: search, tabs, keyboard nav, preview
│   ├── ToolPickerModal.tsx            — Browse project tools + create new
│   ├── ToolCreationForm.tsx           — HTTP/MCP/Sandbox/Lambda tool forms
│   ├── GuardrailPickerModal.tsx       — 5 built-in + create custom
│   ├── TemplatePickerModal.tsx        — Gallery + 7-channel builder
│   ├── GatherFieldBuilder.tsx         — 8 types + validation + inference
│   ├── FlowStepBuilder.tsx            — Reasoning/scripted toggle + fields
│   ├── MemoryBuilder.tsx              — Tabbed: session/persistent/remember/recall
│   ├── ConstraintBuilder.tsx          — Phase + CEL + action
│   └── HandoffBuilder.tsx             — Agent picker + context config
```

### Modified Files

```
apps/studio/src/components/abl/ABLEditor.tsx         — Wire useMonacoCommands + picker state
apps/studio/src/store/editor-store.ts                — Add command palette state
packages/i18n/locales/en/studio.json                 — Add translation keys
packages/i18n/locales/ar/studio.json                 — Arabic translations
```

### New API Route

```
apps/studio/src/app/api/compiler/builtin-guardrails/route.ts
```

---

## Chunk 1: Context Detection + Command Registry + Snippet Generator

These are pure utilities with no UI — fully testable with unit tests.

### Task 1: DSLContextDetector

**Files:**

- Create: `apps/studio/src/components/abl/commands/DSLContextDetector.ts`
- Create: `apps/studio/src/components/abl/commands/DSLContextDetector.test.ts`

**Read first:**

- `packages/core/src/parser/agent-based-parser.ts` — `parseAgentBasedABL` signature
- `packages/core/src/types/agent-based.ts` — `AgentBasedDocument` structure

- [ ] **Step 1: Write failing tests**

```typescript
// DSLContextDetector.test.ts
import { describe, test, expect } from 'vitest';
import { detectDSLContext, type DSLSection } from './DSLContextDetector';

describe('DSLContextDetector', () => {
  test('detects TOOLS section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n  fetch(id: string) -> object\n    description: "test"\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('tools');
  });

  test('detects GUARDRAILS section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nGUARDRAILS:\n  guard1:\n    kind: input\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('guardrails');
  });

  test('detects FLOW section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nFLOW:\n  steps: [welcome]\n\n  welcome:\n    REASONING: false\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 9, column: 3 });
    expect(ctx.section).toBe('flow');
  });

  test('detects root level', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\n`;
    const ctx = detectDSLContext(dsl, { line: 3, column: 1 });
    expect(ctx.section).toBe('root');
  });

  test('detects GATHER section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nGATHER:\n  name:\n    type: string\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('gather');
  });

  test('detects MEMORY section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nMEMORY:\n  SESSION:\n    - x: string\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('memory');
  });

  test('detects CONSTRAINTS section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nCONSTRAINTS:\n  pre:\n    - REQUIRE x > 0\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('constraints');
  });

  test('detects HANDOFF section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nHANDOFF:\n  - TO: Other\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 6, column: 3 });
    expect(ctx.section).toBe('handoff');
  });

  test('detects TEMPLATES section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTEMPLATES:\n  greet:\n    content: "hi"\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('templates');
  });

  test('falls back to line-based detection on malformed YAML', () => {
    const dsl = `AGENT: Test\nGOAL "broken\n\nTOOLS:\n  \n`;
    const ctx = detectDSLContext(dsl, { line: 5, column: 3 });
    expect(ctx.section).toBe('tools');
  });

  test('returns indentLevel from current line', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n    `;
    const ctx = detectDSLContext(dsl, { line: 5, column: 5 });
    expect(ctx.indentLevel).toBe(4);
  });

  test('returns available commands for section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n  `;
    const ctx = detectDSLContext(dsl, { line: 5, column: 3 });
    expect(ctx.availableCommands.length).toBeGreaterThan(0);
    expect(ctx.availableCommands.some((c) => c.id === 'tool')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/studio && pnpm vitest run src/components/abl/commands/DSLContextDetector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DSLContextDetector**

```typescript
// DSLContextDetector.ts
import { parseAgentBasedABL } from '@abl/core';
import { COMMAND_REGISTRY, type Command } from './CommandRegistry';

export type DSLSection =
  | 'root'
  | 'identity'
  | 'tools'
  | 'guardrails'
  | 'templates'
  | 'flow'
  | 'flow.step'
  | 'gather'
  | 'memory'
  | 'constraints'
  | 'delegates'
  | 'handoff'
  | 'escalation'
  | 'error_handling'
  | 'completion'
  | 'execution'
  | 'hooks'
  | 'messages'
  | 'unknown';

export interface DSLContext {
  section: DSLSection;
  line: number;
  column: number;
  indentLevel: number;
  availableCommands: Command[];
}

interface Position {
  line: number;
  column: number;
}

// Section keyword → DSLSection mapping for line-based fallback
const SECTION_KEYWORDS: Record<string, DSLSection> = {
  'TOOLS:': 'tools',
  'GUARDRAILS:': 'guardrails',
  'TEMPLATES:': 'templates',
  'MESSAGES:': 'messages',
  'FLOW:': 'flow',
  'STEPS:': 'flow',
  'GATHER:': 'gather',
  'MEMORY:': 'memory',
  'CONSTRAINTS:': 'constraints',
  'DELEGATE:': 'delegates',
  'HANDOFF:': 'handoff',
  'ESCALATE:': 'escalation',
  'ESCALATION:': 'escalation',
  'ON_ERROR:': 'error_handling',
  'COMPLETE:': 'completion',
  'ON_START:': 'root',
  'EXECUTION:': 'execution',
  'HOOKS:': 'hooks',
  'IDENTITY:': 'identity',
  'NLU:': 'root',
  'SYSTEM_PROMPT:': 'root',
  // YAML lowercase variants
  'tools:': 'tools',
  'guardrails:': 'guardrails',
  'templates:': 'templates',
  'flow:': 'flow',
  'gather:': 'gather',
  'memory:': 'memory',
  'constraints:': 'constraints',
  'handoff:': 'handoff',
  'delegate:': 'delegates',
  'escalate:': 'escalation',
  'execution:': 'execution',
};

/**
 * Detect DSL section at cursor position.
 * Primary: AST parsing. Fallback: line-based keyword search.
 */
export function detectDSLContext(dslContent: string, position: Position): DSLContext {
  const lines = dslContent.split('\n');
  const currentLine = lines[position.line - 1] || '';
  const indentLevel = currentLine.search(/\S|$/);

  // Try AST-based detection first
  let section = detectByAST(dslContent, position);

  // Fallback to line-based if AST fails
  if (section === 'unknown') {
    section = detectByLine(lines, position.line);
  }

  const availableCommands = getCommandsForSection(section);

  return {
    section,
    line: position.line,
    column: position.column,
    indentLevel,
    availableCommands,
  };
}

function detectByAST(dslContent: string, position: Position): DSLSection {
  try {
    const result = parseAgentBasedABL(dslContent);
    if (!result.document) return 'unknown';

    const doc = result.document;
    const line = position.line;

    // Walk through document sections and find which one contains the cursor
    // We use a simple approach: find the last section header before the cursor line
    const lines = dslContent.split('\n');
    return detectByLine(lines, line);
  } catch {
    return 'unknown';
  }
}

function detectByLine(lines: string[], cursorLine: number): DSLSection {
  // Search backwards from cursor for a section keyword at indent 0
  for (let i = cursorLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    // Check if this is a top-level section (no leading whitespace)
    const indent = line.search(/\S|$/);
    if (indent > 0) continue;

    for (const [keyword, section] of Object.entries(SECTION_KEYWORDS)) {
      if (trimmed.startsWith(keyword)) {
        return section;
      }
    }
  }

  return 'root';
}

function getCommandsForSection(section: DSLSection): Command[] {
  return COMMAND_REGISTRY.filter(
    (cmd) => cmd.availableIn.includes(section) || cmd.availableIn.includes('root'),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/components/abl/commands/DSLContextDetector.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/commands/DSLContextDetector.ts apps/studio/src/components/abl/commands/DSLContextDetector.test.ts
git add apps/studio/src/components/abl/commands/
git commit -m "[ABLP-47] feat(studio): add DSLContextDetector for cursor section detection"
```

---

### Task 2: CommandRegistry

**Files:**

- Create: `apps/studio/src/components/abl/commands/CommandRegistry.ts`
- Create: `apps/studio/src/components/abl/commands/CommandRegistry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// CommandRegistry.test.ts
import { describe, test, expect } from 'vitest';
import { COMMAND_REGISTRY, getCommandsForSection } from './CommandRegistry';

describe('CommandRegistry', () => {
  test('has at least 15 commands', () => {
    expect(COMMAND_REGISTRY.length).toBeGreaterThanOrEqual(15);
  });

  test('tools section returns tool commands', () => {
    const cmds = getCommandsForSection('tools');
    expect(cmds.some((c) => c.id === 'tool')).toBe(true);
    expect(cmds.some((c) => c.id === 'http-tool')).toBe(true);
    expect(cmds.some((c) => c.id === 'mcp-tool')).toBe(true);
  });

  test('guardrails section returns guardrail commands', () => {
    const cmds = getCommandsForSection('guardrails');
    expect(cmds.some((c) => c.id === 'guardrail')).toBe(true);
    expect(cmds.some((c) => c.id === 'builtin-guard')).toBe(true);
  });

  test('flow section returns step commands', () => {
    const cmds = getCommandsForSection('flow');
    expect(cmds.some((c) => c.id === 'step')).toBe(true);
    expect(cmds.some((c) => c.id === 'reasoning-step')).toBe(true);
  });

  test('root section returns all commands', () => {
    const cmds = getCommandsForSection('root');
    expect(cmds.length).toBeGreaterThan(10);
  });

  test('every command has required fields', () => {
    for (const cmd of COMMAND_REGISTRY) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.label).toMatch(/^\//);
      expect(cmd.description).toBeTruthy();
      expect(cmd.availableIn.length).toBeGreaterThan(0);
    }
  });

  test('no duplicate command IDs', () => {
    const ids = COMMAND_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/studio && pnpm vitest run src/components/abl/commands/CommandRegistry.test.ts`

- [ ] **Step 3: Implement CommandRegistry**

```typescript
// CommandRegistry.ts
import type { DSLSection } from './DSLContextDetector';

export interface Command {
  id: string;
  label: string;
  description: string;
  category: string;
  availableIn: DSLSection[];
}

export const COMMAND_REGISTRY: Command[] = [
  // Tools
  {
    id: 'tool',
    label: '/tool',
    description: 'Browse & insert tool',
    category: 'Capabilities',
    availableIn: ['tools', 'root'],
  },
  {
    id: 'http-tool',
    label: '/http-tool',
    description: 'New HTTP API tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'mcp-tool',
    label: '/mcp-tool',
    description: 'New MCP tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'sandbox-tool',
    label: '/sandbox-tool',
    description: 'Inline code tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'lambda-tool',
    label: '/lambda-tool',
    description: 'Serverless function',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  {
    id: 'async-tool',
    label: '/async-tool',
    description: 'Async webhook tool',
    category: 'Capabilities',
    availableIn: ['tools'],
  },
  // Guardrails
  {
    id: 'guardrail',
    label: '/guardrail',
    description: 'Browse & insert guardrail',
    category: 'Safety',
    availableIn: ['guardrails', 'root'],
  },
  {
    id: 'builtin-guard',
    label: '/builtin-guard',
    description: 'Built-in guardrail template',
    category: 'Safety',
    availableIn: ['guardrails'],
  },
  {
    id: 'input-guard',
    label: '/input-guard',
    description: 'New input guardrail',
    category: 'Safety',
    availableIn: ['guardrails'],
  },
  {
    id: 'output-guard',
    label: '/output-guard',
    description: 'New output guardrail',
    category: 'Safety',
    availableIn: ['guardrails'],
  },
  // Templates
  {
    id: 'template',
    label: '/template',
    description: 'Browse template gallery',
    category: 'Capabilities',
    availableIn: ['templates', 'root'],
  },
  {
    id: 'multiformat',
    label: '/multiformat',
    description: 'Multi-channel template',
    category: 'Capabilities',
    availableIn: ['templates'],
  },
  {
    id: 'voice-template',
    label: '/voice-template',
    description: 'Voice-only template',
    category: 'Capabilities',
    availableIn: ['templates'],
  },
  // Gather
  {
    id: 'field',
    label: '/field',
    description: 'Add gather field',
    category: 'Capabilities',
    availableIn: ['gather', 'root'],
  },
  {
    id: 'string-field',
    label: '/string-field',
    description: 'Text field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'number-field',
    label: '/number-field',
    description: 'Number field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'date-field',
    label: '/date-field',
    description: 'Date field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'email-field',
    label: '/email-field',
    description: 'Email field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  {
    id: 'enum-field',
    label: '/enum-field',
    description: 'Selection field',
    category: 'Capabilities',
    availableIn: ['gather'],
  },
  // Flow
  {
    id: 'step',
    label: '/step',
    description: 'Add flow step',
    category: 'Flow',
    availableIn: ['flow', 'root'],
  },
  {
    id: 'reasoning-step',
    label: '/reasoning-step',
    description: 'LLM-powered step',
    category: 'Flow',
    availableIn: ['flow'],
  },
  {
    id: 'scripted-step',
    label: '/scripted-step',
    description: 'Deterministic step',
    category: 'Flow',
    availableIn: ['flow'],
  },
  {
    id: 'gather-step',
    label: '/gather-step',
    description: 'Data collection step',
    category: 'Flow',
    availableIn: ['flow'],
  },
  {
    id: 'digression',
    label: '/digression',
    description: 'Off-topic handler',
    category: 'Flow',
    availableIn: ['flow'],
  },
  // Memory
  {
    id: 'memory-var',
    label: '/memory-var',
    description: 'Session variable',
    category: 'Memory',
    availableIn: ['memory', 'root'],
  },
  {
    id: 'persistent',
    label: '/persistent',
    description: 'Persistent path',
    category: 'Memory',
    availableIn: ['memory'],
  },
  {
    id: 'remember',
    label: '/remember',
    description: 'Remember trigger',
    category: 'Memory',
    availableIn: ['memory'],
  },
  {
    id: 'recall',
    label: '/recall',
    description: 'Recall instruction',
    category: 'Memory',
    availableIn: ['memory'],
  },
  // Constraints
  {
    id: 'constraint',
    label: '/constraint',
    description: 'Add business rule',
    category: 'Safety',
    availableIn: ['constraints', 'root'],
  },
  {
    id: 'require',
    label: '/require',
    description: 'Blocking rule',
    category: 'Safety',
    availableIn: ['constraints'],
  },
  {
    id: 'warn',
    label: '/warn',
    description: 'Warning rule',
    category: 'Safety',
    availableIn: ['constraints'],
  },
  // Coordination
  {
    id: 'handoff',
    label: '/handoff',
    description: 'Transfer to agent',
    category: 'Coordination',
    availableIn: ['handoff', 'root'],
  },
  {
    id: 'delegate',
    label: '/delegate',
    description: 'Sub-agent task',
    category: 'Coordination',
    availableIn: ['delegates', 'root'],
  },
  {
    id: 'escalate',
    label: '/escalate',
    description: 'Human escalation',
    category: 'Coordination',
    availableIn: ['escalation', 'root'],
  },
  // Lifecycle
  {
    id: 'onstart',
    label: '/onstart',
    description: 'Welcome + init',
    category: 'Lifecycle',
    availableIn: ['root'],
  },
  {
    id: 'complete',
    label: '/complete',
    description: 'Completion condition',
    category: 'Lifecycle',
    availableIn: ['completion', 'root'],
  },
  {
    id: 'onerror',
    label: '/onerror',
    description: 'Error handler',
    category: 'Lifecycle',
    availableIn: ['error_handling', 'root'],
  },
  {
    id: 'hook',
    label: '/hook',
    description: 'Lifecycle hook',
    category: 'Lifecycle',
    availableIn: ['hooks', 'root'],
  },
];

export function getCommandsForSection(section: DSLSection): Command[] {
  if (section === 'root') {
    return COMMAND_REGISTRY;
  }
  return COMMAND_REGISTRY.filter(
    (cmd) => cmd.availableIn.includes(section) || cmd.availableIn.includes('root'),
  );
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query) return commands;
  const q = query.toLowerCase().replace(/^\//, '');
  return commands.filter(
    (cmd) =>
      cmd.id.includes(q) || cmd.label.includes(q) || cmd.description.toLowerCase().includes(q),
  );
}

export function groupCommandsByCategory(commands: Command[]): Record<string, Command[]> {
  const groups: Record<string, Command[]> = {};
  for (const cmd of commands) {
    if (!groups[cmd.category]) groups[cmd.category] = [];
    groups[cmd.category].push(cmd);
  }
  return groups;
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/components/abl/commands/CommandRegistry.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/commands/CommandRegistry.ts apps/studio/src/components/abl/commands/CommandRegistry.test.ts
git add apps/studio/src/components/abl/commands/
git commit -m "[ABLP-47] feat(studio): add CommandRegistry with 35+ slash commands"
```

---

### Task 3: SnippetGenerator

**Files:**

- Create: `apps/studio/src/components/abl/commands/SnippetGenerator.ts`
- Create: `apps/studio/src/components/abl/commands/SnippetGenerator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// SnippetGenerator.test.ts
import { describe, test, expect } from 'vitest';
import {
  generateToolSnippet,
  generateGuardrailSnippet,
  generateGatherFieldSnippet,
  generateFlowStepSnippet,
  generateMemoryVarSnippet,
  generateHandoffSnippet,
  generateConstraintSnippet,
  applyIndent,
} from './SnippetGenerator';

describe('SnippetGenerator', () => {
  describe('applyIndent', () => {
    test('applies 2-space indent to all lines', () => {
      const snippet = 'line1\nline2\nline3';
      const result = applyIndent(snippet, 2);
      expect(result).toBe('  line1\n  line2\n  line3');
    });

    test('applies 4-space indent', () => {
      const result = applyIndent('foo\nbar', 4);
      expect(result).toBe('    foo\n    bar');
    });

    test('handles empty string', () => {
      expect(applyIndent('', 2)).toBe('');
    });
  });

  describe('generateToolSnippet', () => {
    test('generates minimal tool', () => {
      const snippet = generateToolSnippet({
        name: 'fetch_data',
        description: 'Fetch data from API',
        parameters: [],
        returns: 'object',
      });
      expect(snippet).toContain('fetch_data');
      expect(snippet).toContain('description:');
      expect(snippet).toContain('Fetch data from API');
    });

    test('generates tool with parameters', () => {
      const snippet = generateToolSnippet({
        name: 'search',
        description: 'Search items',
        parameters: [
          { name: 'query', type: 'string', required: true },
          { name: 'limit', type: 'number', required: false },
        ],
        returns: 'object',
      });
      expect(snippet).toContain('query: string');
      expect(snippet).toContain('limit: number');
    });

    test('generates HTTP tool with binding', () => {
      const snippet = generateToolSnippet({
        name: 'get_user',
        description: 'Get user by ID',
        parameters: [{ name: 'userId', type: 'string', required: true }],
        returns: 'object',
        toolType: 'http',
        httpBinding: {
          method: 'GET',
          endpoint: 'https://api.example.com/users/{userId}',
          auth: 'bearer',
        },
      });
      expect(snippet).toContain('type: http');
      expect(snippet).toContain('method: GET');
      expect(snippet).toContain('endpoint:');
      expect(snippet).toContain('auth: bearer');
    });
  });

  describe('generateGuardrailSnippet', () => {
    test('generates input guardrail with CEL check', () => {
      const snippet = generateGuardrailSnippet({
        name: 'pii_guard',
        kind: 'input',
        check: 'not_matches_pattern(input, "\\\\b\\\\d{3}-\\\\d{2}-\\\\d{4}\\\\b")',
        action: 'redact',
        message: 'SSN redacted',
      });
      expect(snippet).toContain('pii_guard:');
      expect(snippet).toContain('kind: input');
      expect(snippet).toContain('action: redact');
    });
  });

  describe('generateGatherFieldSnippet', () => {
    test('generates string field', () => {
      const snippet = generateGatherFieldSnippet({
        name: 'customer_name',
        type: 'string',
        prompt: 'Your name?',
        required: true,
      });
      expect(snippet).toContain('customer_name:');
      expect(snippet).toContain('type: string');
      expect(snippet).toContain('required: true');
    });
  });

  describe('generateFlowStepSnippet', () => {
    test('generates reasoning step', () => {
      const snippet = generateFlowStepSnippet({
        name: 'search',
        reasoning: true,
        goal: 'Find best options',
        exitWhen: 'selected == true',
        maxTurns: 5,
        then: 'confirm',
      });
      expect(snippet).toContain('REASONING: true');
      expect(snippet).toContain('GOAL:');
      expect(snippet).toContain('EXIT_WHEN:');
      expect(snippet).toContain('THEN: confirm');
    });

    test('generates scripted step', () => {
      const snippet = generateFlowStepSnippet({
        name: 'welcome',
        reasoning: false,
        respond: 'Hello!',
        then: 'collect',
      });
      expect(snippet).toContain('REASONING: false');
      expect(snippet).toContain('RESPOND:');
      expect(snippet).toContain('THEN: collect');
    });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/studio && pnpm vitest run src/components/abl/commands/SnippetGenerator.test.ts`

- [ ] **Step 3: Implement SnippetGenerator**

```typescript
// SnippetGenerator.ts

/**
 * Apply indentation to every line of a snippet.
 */
export function applyIndent(snippet: string, spaces: number): string {
  if (!snippet) return '';
  const indent = ' '.repeat(spaces);
  return snippet
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}

// --- Tool Snippet ---

interface ToolSnippetInput {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; required: boolean }>;
  returns: string;
  toolType?: string;
  httpBinding?: { method: string; endpoint: string; auth?: string; timeout?: number };
  mcpBinding?: { server: string; tool?: string };
  sandboxBinding?: { runtime: string; code?: string };
}

export function generateToolSnippet(input: ToolSnippetInput): string {
  const params = input.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
  const lines: string[] = [];

  lines.push(`${input.name}(${params}) -> ${input.returns}`);
  lines.push(`  description: "${input.description}"`);

  if (input.toolType) {
    lines.push(`  type: ${input.toolType}`);
  }

  if (input.httpBinding) {
    lines.push('  http:');
    lines.push(`    method: ${input.httpBinding.method}`);
    lines.push(`    endpoint: "${input.httpBinding.endpoint}"`);
    if (input.httpBinding.auth) lines.push(`    auth: ${input.httpBinding.auth}`);
    if (input.httpBinding.timeout) lines.push(`    timeout: ${input.httpBinding.timeout}`);
  }

  if (input.mcpBinding) {
    lines.push('  mcp:');
    lines.push(`    server: "${input.mcpBinding.server}"`);
    if (input.mcpBinding.tool) lines.push(`    tool: "${input.mcpBinding.tool}"`);
  }

  if (input.sandboxBinding) {
    lines.push('  sandbox:');
    lines.push(`    runtime: ${input.sandboxBinding.runtime}`);
    if (input.sandboxBinding.code) {
      lines.push('    code: |');
      for (const codeLine of input.sandboxBinding.code.split('\n')) {
        lines.push(`      ${codeLine}`);
      }
    }
  }

  return lines.join('\n');
}

// --- Guardrail Snippet ---

interface GuardrailSnippetInput {
  name: string;
  kind: string;
  check?: string;
  llmCheck?: string;
  action: string;
  message?: string;
  priority?: number;
}

export function generateGuardrailSnippet(input: GuardrailSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  kind: ${input.kind}`);
  if (input.check) lines.push(`  check: ${JSON.stringify(input.check)}`);
  if (input.llmCheck) lines.push(`  llm_check: ${JSON.stringify(input.llmCheck)}`);
  lines.push(`  action: ${input.action}`);
  if (input.message) lines.push(`  message: "${input.message}"`);
  if (input.priority != null) lines.push(`  priority: ${input.priority}`);
  return lines.join('\n');
}

// --- Gather Field Snippet ---

interface GatherFieldSnippetInput {
  name: string;
  type: string;
  prompt: string;
  required: boolean;
  validate?: string;
  retryPrompt?: string;
  infer?: boolean;
  sensitive?: boolean;
}

export function generateGatherFieldSnippet(input: GatherFieldSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  prompt: "${input.prompt}"`);
  lines.push(`  type: ${input.type}`);
  lines.push(`  required: ${input.required}`);
  if (input.validate) lines.push(`  validate: "${input.validate}"`);
  if (input.retryPrompt) lines.push(`  retryPrompt: "${input.retryPrompt}"`);
  if (input.infer) lines.push('  infer: true');
  if (input.sensitive) lines.push('  sensitive: true');
  return lines.join('\n');
}

// --- Flow Step Snippet ---

interface FlowStepSnippetInput {
  name: string;
  reasoning: boolean;
  goal?: string;
  exitWhen?: string;
  maxTurns?: number;
  availableTools?: string[];
  respond?: string;
  call?: string;
  then?: string;
}

export function generateFlowStepSnippet(input: FlowStepSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.name}:`);
  lines.push(`  REASONING: ${input.reasoning}`);
  if (input.goal) lines.push(`  GOAL: "${input.goal}"`);
  if (input.availableTools?.length) {
    lines.push(`  AVAILABLE_TOOLS: [${input.availableTools.join(', ')}]`);
  }
  if (input.exitWhen) lines.push(`  EXIT_WHEN: ${input.exitWhen}`);
  if (input.maxTurns != null) lines.push(`  MAX_TURNS: ${input.maxTurns}`);
  if (input.respond) lines.push(`  RESPOND: "${input.respond}"`);
  if (input.call) lines.push(`  CALL: ${input.call}`);
  if (input.then) lines.push(`  THEN: ${input.then}`);
  return lines.join('\n');
}

// --- Memory Var Snippet ---

interface MemoryVarSnippetInput {
  name: string;
  type: string;
  initialValue?: string;
}

export function generateMemoryVarSnippet(input: MemoryVarSnippetInput): string {
  let line = `- ${input.name}: ${input.type}`;
  if (input.initialValue != null) line += ` = ${input.initialValue}`;
  return line;
}

// --- Handoff Snippet ---

interface HandoffSnippetInput {
  to: string;
  when: string;
  priority?: number;
  contextPass?: string[];
  history?: string;
  returnEnabled?: boolean;
}

export function generateHandoffSnippet(input: HandoffSnippetInput): string {
  const lines: string[] = [];
  lines.push(`- TO: ${input.to}`);
  lines.push(`  WHEN: "${input.when}"`);
  if (input.priority != null) lines.push(`  PRIORITY: ${input.priority}`);
  if (input.contextPass?.length) {
    lines.push('  CONTEXT:');
    lines.push(`    pass: [${input.contextPass.map((p) => `"${p}"`).join(', ')}]`);
    if (input.history) lines.push(`    history: ${input.history}`);
  }
  if (input.returnEnabled != null) lines.push(`  RETURN: ${input.returnEnabled}`);
  return lines.join('\n');
}

// --- Constraint Snippet ---

interface ConstraintSnippetInput {
  phase: string;
  severity: 'REQUIRE' | 'WARN';
  condition: string;
  onFail: string;
}

export function generateConstraintSnippet(input: ConstraintSnippetInput): string {
  const lines: string[] = [];
  lines.push(`${input.phase}:`);
  lines.push(`  - ${input.severity}: ${input.condition}`);
  lines.push(`    ON_FAIL: "${input.onFail}"`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/components/abl/commands/SnippetGenerator.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/commands/SnippetGenerator.ts apps/studio/src/components/abl/commands/SnippetGenerator.test.ts
git add apps/studio/src/components/abl/commands/
git commit -m "[ABLP-47] feat(studio): add SnippetGenerator for indent-aware YAML generation"
```

---

## Chunk 2: Monaco Integration + Command Palette Widget

### Task 4: useMonacoCommands Hook

**Files:**

- Create: `apps/studio/src/components/abl/commands/useMonacoCommands.ts`
- Modify: `apps/studio/src/components/abl/ABLEditor.tsx`
- Modify: `apps/studio/src/store/editor-store.ts`

**Read first:**

- `apps/studio/src/components/abl/ABLEditor.tsx` — how Monaco providers are registered (line 179-303)
- `apps/studio/src/store/editor-store.ts` — existing state shape

- [ ] **Step 1: Add command palette state to editor store**

Add to `apps/studio/src/store/editor-store.ts`:

```typescript
// Add to EditorState interface:
commandPaletteOpen: boolean;
commandPalettePosition: { top: number; left: number } | null;
commandPaletteSection: string | null;
setCommandPaletteOpen: (open: boolean) => void;
setCommandPalettePosition: (pos: { top: number; left: number } | null) => void;
setCommandPaletteSection: (section: string | null) => void;

// Add to create() defaults:
commandPaletteOpen: false,
commandPalettePosition: null,
commandPaletteSection: null,
setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
setCommandPalettePosition: (pos) => set({ commandPalettePosition: pos }),
setCommandPaletteSection: (section) => set({ commandPaletteSection: section }),
```

- [ ] **Step 2: Create useMonacoCommands hook**

```typescript
// useMonacoCommands.ts
import { useCallback, useRef } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { detectDSLContext } from './DSLContextDetector';
import { useEditorStore } from '../../../store/editor-store';

/**
 * Hook that registers "/" slash command trigger and keyboard shortcuts
 * on the Monaco editor instance. Returns a setup function to call on mount.
 */
export function useMonacoCommands() {
  const disposablesRef = useRef<IDisposable[]>([]);

  const setup = useCallback((editorInstance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    // Clean up previous disposables
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

    // Listen for "/" keypress to trigger command palette
    const keyDisposable = editorInstance.onKeyUp((e) => {
      if (e.keyCode !== monaco.KeyCode.Slash) return;

      const position = editorInstance.getPosition();
      if (!position) return;

      const model = editorInstance.getModel();
      if (!model) return;

      // Check if "/" is at start of word or after whitespace
      const lineContent = model.getLineContent(position.lineNumber);
      const charBefore = lineContent[position.column - 3]; // char before the "/"
      if (charBefore && !/\s/.test(charBefore)) return;

      // Get cursor pixel position for palette placement
      const coords = editorInstance.getScrolledVisiblePosition(position);
      if (!coords) return;

      const editorDom = editorInstance.getDomNode();
      if (!editorDom) return;
      const rect = editorDom.getBoundingClientRect();

      // Detect DSL context
      const dslContent = model.getValue();
      const context = detectDSLContext(dslContent, {
        line: position.lineNumber,
        column: position.column,
      });

      // Open command palette
      const store = useEditorStore.getState();
      store.setCommandPalettePosition({
        top: rect.top + coords.top + 20,
        left: rect.left + coords.left,
      });
      store.setCommandPaletteSection(context.section);
      store.setCommandPaletteOpen(true);
    });

    // Ctrl+Space shortcut for context picker
    const ctrlSpaceAction = editorInstance.addAction({
      id: 'abl.openContextPicker',
      label: 'ABL: Open Context Picker',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space],
      run: (ed) => {
        const position = ed.getPosition();
        if (!position) return;
        const model = ed.getModel();
        if (!model) return;

        const coords = ed.getScrolledVisiblePosition(position);
        if (!coords) return;
        const editorDom = ed.getDomNode();
        if (!editorDom) return;
        const rect = editorDom.getBoundingClientRect();

        const context = detectDSLContext(model.getValue(), {
          line: position.lineNumber,
          column: position.column,
        });

        const store = useEditorStore.getState();
        store.setCommandPalettePosition({
          top: rect.top + coords.top + 20,
          left: rect.left + coords.left,
        });
        store.setCommandPaletteSection(context.section);
        store.setCommandPaletteOpen(true);
      },
    });

    disposablesRef.current.push(keyDisposable, ctrlSpaceAction);
  }, []);

  const cleanup = useCallback(() => {
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];
  }, []);

  return { setup, cleanup };
}
```

- [ ] **Step 3: Wire into ABLEditor.tsx**

Add to `ABLEditor.tsx` imports and setup:

```typescript
// Add import
import { useMonacoCommands } from './commands/useMonacoCommands';
import { CommandPaletteWidget } from './commands/CommandPaletteWidget';

// Inside ABLEditorInner:
const { setup: setupCommands, cleanup: cleanupCommands } = useMonacoCommands();

// In handleEditorMount, after existing setup:
setupCommands(editor, monaco);

// In cleanup useEffect:
cleanupCommands();

// In JSX, after ToolPickerDialog:
<CommandPaletteWidget
  editorRef={editorRef}
  projectId={projectId}
/>
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/commands/useMonacoCommands.ts apps/studio/src/store/editor-store.ts apps/studio/src/components/abl/ABLEditor.tsx
git add apps/studio/src/components/abl/commands/ apps/studio/src/store/editor-store.ts apps/studio/src/components/abl/ABLEditor.tsx
git commit -m "[ABLP-47] feat(studio): add useMonacoCommands hook with / trigger and Ctrl+Space"
```

---

### Task 5: CommandPaletteWidget

**Files:**

- Create: `apps/studio/src/components/abl/commands/CommandPaletteWidget.tsx`

**Read first:**

- `apps/studio/src/components/ui/Dialog.tsx` — existing Dialog pattern for animation reference
- The wireframe at `apps/studio/public/agent-anatomy/monaco-editor-wireframe.html` — sections 1-5

- [ ] **Step 1: Create CommandPaletteWidget**

```typescript
// CommandPaletteWidget.tsx
'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import type { editor } from 'monaco-editor';
import { useEditorStore } from '../../../store/editor-store';
import {
  getCommandsForSection,
  filterCommands,
  groupCommandsByCategory,
  type Command,
} from './CommandRegistry';
import type { DSLSection } from './DSLContextDetector';

interface CommandPaletteWidgetProps {
  editorRef: RefObject<editor.IStandaloneCodeEditor | null>;
  projectId?: string;
  onCommandSelect?: (command: Command) => void;
}

export function CommandPaletteWidget({
  editorRef,
  projectId,
  onCommandSelect,
}: CommandPaletteWidgetProps) {
  const isOpen = useEditorStore((s) => s.commandPaletteOpen);
  const position = useEditorStore((s) => s.commandPalettePosition);
  const section = useEditorStore((s) => s.commandPaletteSection) as DSLSection | null;
  const setOpen = useEditorStore((s) => s.setCommandPaletteOpen);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = section ? getCommandsForSection(section) : [];
  const filtered = filterCommands(commands, query);
  const grouped = groupCommandsByCategory(filtered);
  const flatFiltered = filtered;

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus happens after render
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = flatFiltered[selectedIndex];
        if (cmd) selectCommand(cmd);
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, flatFiltered, selectedIndex]);

  const close = useCallback(() => {
    setOpen(false);
    editorRef.current?.focus();
  }, [setOpen, editorRef]);

  const selectCommand = useCallback(
    (cmd: Command) => {
      close();

      // Remove the "/" character that triggered the palette
      const ed = editorRef.current;
      if (ed) {
        const pos = ed.getPosition();
        if (pos) {
          const model = ed.getModel();
          if (model) {
            const lineContent = model.getLineContent(pos.lineNumber);
            const slashIndex = lineContent.lastIndexOf('/', pos.column - 1);
            if (slashIndex >= 0) {
              ed.executeEdits('command-palette', [
                {
                  range: {
                    startLineNumber: pos.lineNumber,
                    startColumn: slashIndex + 1,
                    endLineNumber: pos.lineNumber,
                    endColumn: pos.column,
                  },
                  text: '',
                  forceMoveMarkers: true,
                },
              ]);
            }
          }
        }
      }

      onCommandSelect?.(cmd);
    },
    [close, editorRef, onCommandSelect],
  );

  if (!isOpen || !position) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.1 }}
        className="fixed z-50"
        style={{ top: position.top, left: position.left }}
      >
        <div className="w-[320px] bg-background-elevated border border-default rounded-lg shadow-xl overflow-hidden">
          {/* Context badge */}
          {section && section !== 'root' && (
            <div className="px-3 py-1.5 text-xs text-accent bg-accent-subtle border-b border-default">
              Context: {section.toUpperCase()} section
            </div>
          )}

          {/* Search (hidden for small palettes, shown for root) */}
          {section === 'root' && (
            <div className="px-3 py-2 border-b border-default">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="Search commands..."
                className="w-full px-2 py-1 text-xs bg-background-muted border border-default rounded-md text-foreground placeholder:text-subtle focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Command list */}
          <div className="max-h-[320px] overflow-y-auto">
            {Object.entries(grouped).map(([category, categoryCommands]) => (
              <div key={category}>
                {Object.keys(grouped).length > 1 && (
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-subtle bg-background-muted">
                    {category}
                  </div>
                )}
                {categoryCommands.map((cmd) => {
                  const globalIdx = flatFiltered.indexOf(cmd);
                  return (
                    <button
                      key={cmd.id}
                      className={clsx(
                        'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-default',
                        globalIdx === selectedIndex
                          ? 'bg-accent-subtle border-l-2 border-accent text-foreground'
                          : 'text-foreground-muted hover:bg-background-muted',
                      )}
                      onClick={() => selectCommand(cmd)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                    >
                      <span className="font-mono font-semibold text-foreground-muted">
                        {cmd.label}
                      </span>
                      <span className="text-subtle ml-auto">{cmd.description}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-3 py-1.5 text-[10px] text-subtle border-t border-default flex gap-3">
            <span>
              <kbd className="px-1 py-0.5 bg-background-muted rounded text-[9px]">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-background-muted rounded text-[9px]">⏎</kbd> Select
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-background-muted rounded text-[9px]">Esc</kbd> Close
            </span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Test manually**

Run Studio dev server, open any agent in DSL editor, type `/` in the TOOLS section.
Expected: Command palette appears at cursor with tool-specific commands.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/commands/CommandPaletteWidget.tsx
git add apps/studio/src/components/abl/commands/
git commit -m "[ABLP-47] feat(studio): add CommandPaletteWidget with keyboard navigation"
```

---

## Chunk 3: BasePickerModal + Tool Picker

### Task 6: BasePickerModal

**Files:**

- Create: `apps/studio/src/components/abl/pickers/BasePickerModal.tsx`

**Read first:**

- `apps/studio/src/components/ui/Dialog.tsx` — animation patterns (springs, transitions)
- `apps/studio/src/lib/animation.ts` — shared animation config
- Wireframe section 6 (Tool Picker) for layout reference

- [ ] **Step 1: Create BasePickerModal**

This is the shared foundation for all picker modals. Key features:

- Search input with debounce
- Tab filters
- Left list + right preview split
- Keyboard navigation (↑↓ Enter Esc Tab)
- "Create New" section
- Footer with shortcut hints

```typescript
// BasePickerModal.tsx — shared picker layout
// See wireframe section 6 for visual reference
// Props: isOpen, onClose, title, searchPlaceholder,
//        tabs, items, categories, renderItem, renderPreview,
//        onSelect, createOptions, footer
```

Implementation: Full component with Radix Dialog + Framer Motion. Uses render props for item and preview rendering. Manages selected item state, search filtering, keyboard navigation.

- [ ] **Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/pickers/BasePickerModal.tsx
git add apps/studio/src/components/abl/pickers/
git commit -m "[ABLP-47] feat(studio): add BasePickerModal shared picker component"
```

---

### Task 7: ToolPickerModal

**Files:**

- Create: `apps/studio/src/components/abl/pickers/ToolPickerModal.tsx`
- Create: `apps/studio/src/components/abl/pickers/ToolCreationForm.tsx`

**Read first:**

- `apps/studio/src/components/abl/ToolPickerDialog.tsx` — existing tool picker (line 29: `buildToolSignatureSnippet`)
- `apps/studio/src/api/tools.ts` — `fetchTools` function
- `apps/studio/src/store/tool-store.ts` — `ToolWithVersion` type

- [ ] **Step 1: Create ToolPickerModal with browse + preview**

Wraps `BasePickerModal` with:

- Fetch project tools via `fetchTools(projectId)`
- Tab filters: All, HTTP, MCP, Lambda, Sandbox, Webhook
- Left panel: tool list with name, description, type badge
- Right panel: preview with params, returns, binding config, generated DSL
- "Create New" options: New HTTP Tool, New MCP Tool, etc.
- Insert button calls `generateToolSnippet()` → `onInsert(snippet)`

- [ ] **Step 2: Create ToolCreationForm**

Form for creating new tools inline:

- Tool name, description inputs
- Method/endpoint/auth for HTTP
- Server picker for MCP
- Runtime/code for Sandbox
- Live DSL preview at bottom
- Insert button

- [ ] **Step 3: Wire ToolPickerModal into ABLEditor**

In `ABLEditor.tsx`, when command palette selects `/tool`:

- Close palette
- Open `ToolPickerModal`
- On insert: call `editor.executeEdits()` with generated snippet

- [ ] **Step 4: Test manually**

Type `/tool` in TOOLS section → picker opens → select a tool → YAML inserted at cursor.

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/abl/pickers/ToolPickerModal.tsx apps/studio/src/components/abl/pickers/ToolCreationForm.tsx
git add apps/studio/src/components/abl/pickers/ apps/studio/src/components/abl/ABLEditor.tsx
git commit -m "[ABLP-47] feat(studio): add ToolPickerModal with browse, preview, and creation form"
```

---

## Chunk 4: Guardrail Picker + API

### Task 8: Builtin Guardrails API

**Files:**

- Create: `apps/studio/src/app/api/compiler/builtin-guardrails/route.ts`

- [ ] **Step 1: Create API route**

```typescript
// route.ts
import { NextResponse } from 'next/server';
import { getBuiltinGuardrailTemplates } from '@abl/compiler/platform/guardrails/builtin-templates';

export async function GET() {
  const guardrails = getBuiltinGuardrailTemplates();
  return NextResponse.json({ guardrails });
}
```

- [ ] **Step 2: Test with curl**

Run: `curl http://localhost:5173/api/compiler/builtin-guardrails | jq .`
Expected: JSON with 5 guardrail templates

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/app/api/compiler/builtin-guardrails/
git commit -m "[ABLP-47] feat(studio): add GET /api/compiler/builtin-guardrails endpoint"
```

### Task 9: GuardrailPickerModal

**Files:**

- Create: `apps/studio/src/components/abl/pickers/GuardrailPickerModal.tsx`

- [ ] **Step 1: Create GuardrailPickerModal**

Uses `BasePickerModal` with:

- Fetch built-in guardrails from `/api/compiler/builtin-guardrails`
- Tab filters: All, Input, Output, Both
- Preview: CEL expression, example triggers (pass/fail), tier indicator
- "Create New" options: Custom Input Guard, Custom Output Guard, PII Protection
- Uses `generateGuardrailSnippet()` for insertion

- [ ] **Step 2: Wire into ABLEditor command handling**

- [ ] **Step 3: Test manually and commit**

---

## Chunk 5: Remaining Pickers

### Task 10: TemplatePickerModal

### Task 11: GatherFieldBuilder

### Task 12: FlowStepBuilder

### Task 13: MemoryBuilder + ConstraintBuilder + HandoffBuilder

Each follows the same pattern:

1. Create modal component using `BasePickerModal`
2. Use the corresponding `generate*Snippet()` function
3. Wire into ABLEditor command handling
4. Test manually
5. Commit

---

## Chunk 6: i18n + Accessibility + Polish

### Task 14: i18n Translation Keys

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`
- Modify: `packages/i18n/locales/ar/studio.json`

Add keys under `agents.abl_editor.commands`:

- `command_palette_title`, `search_commands`, `context_label`
- `insert_tool`, `insert_guardrail`, `insert_template`, etc.
- `create_new`, `preview`, `insert_at_cursor`, `copy`, `cancel`
- All picker titles, descriptions, and button labels

### Task 15: Accessibility

- ARIA labels on all interactive elements
- Focus trapping in modals (already handled by Radix Dialog)
- `role="listbox"` on command palette items
- `aria-selected` on focused item
- Screen reader announcements for palette open/close

### Task 16: Error Handling + Performance

- API fetch failure → cached data + retry button
- Empty project (no tools) → "Create New" prominent
- Search debounce (200ms)
- Cache fetched tools/guardrails (30s TTL)
- Virtual scroll for 50+ items (if needed)

### Task 17: Final Commit

```bash
npx prettier --write apps/studio/src/components/abl/**/*.{ts,tsx}
git add -A
git commit -m "[ABLP-47] feat(studio): add i18n, accessibility, and polish for inline editing"
```

---

## Testing Checklist

- [ ] Unit: DSLContextDetector detects all 12+ sections correctly
- [ ] Unit: CommandRegistry filters commands by section
- [ ] Unit: SnippetGenerator produces valid YAML for all construct types
- [ ] Integration: `/` in TOOLS → palette shows tool commands
- [ ] Integration: `/` in GUARDRAILS → palette shows guardrail commands
- [ ] Integration: `/` in FLOW → palette shows step commands
- [ ] Integration: `/` at root → palette shows all commands grouped
- [ ] Integration: Select `/tool` → ToolPickerModal opens
- [ ] Integration: Select tool from picker → YAML inserted at cursor with correct indent
- [ ] Integration: Select `/guardrail` → GuardrailPickerModal with 5 built-ins
- [ ] Integration: Insert guardrail → valid YAML with CEL expression
- [ ] E2E: Full flow — open editor, type `/`, select command, pick item, verify insertion
- [ ] Keyboard: ↑↓ navigates palette, Enter selects, Esc closes
- [ ] Keyboard: Tab toggles preview in pickers
- [ ] Error: API fetch fails → shows cached data + retry
- [ ] Performance: Palette opens in <50ms, picker in <100ms
