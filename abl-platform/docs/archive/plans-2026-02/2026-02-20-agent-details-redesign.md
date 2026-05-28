# Agent Details Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the 5-tab Agent Detail view with a single scrollable page of collapsible section cards, each providing a structured editor for one ABL concept, with contextual Arch AI integration.

**Architecture:** Single scrollable page reads agent DSL, compiles to IR via `/api/abl/compile`, parses IR into 7 section view models (Identity, Tools, Gather, Flow, Rules, Coordination, Lifecycle). Each section renders as a collapsible card with inline form editor. Edits debounce through the surgical edit API (`/api/projects/:id/agents/:agentId/edit`), which patches ABL sections and returns updated DSL. Arch AI panel tracks the active section via `editContext` on the arch store for contextual suggestions. DSL Editor, Chat, and Versions become header action overlays/slide-overs instead of tabs.

**Tech Stack:** Next.js 15, React 18, TypeScript, Zustand, SWR, Tailwind CSS, Framer Motion, Lucide icons, clsx

**Design Doc:** `docs/plans/2026-02-20-agent-details-redesign-design.md`

---

## Task 1: Create agent-detail-store (Zustand store for section states)

This store manages which sections are expanded, the parsed IR section data, dirty tracking, and auto-save state. All other tasks depend on this store.

**Files:**

- Create: `apps/studio/src/store/agent-detail-store.ts`
- Test: `apps/studio/src/__tests__/agent-detail-store.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/agent-detail-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentDetailStore } from '../store/agent-detail-store';

describe('agent-detail-store', () => {
  beforeEach(() => {
    useAgentDetailStore.getState().reset();
  });

  describe('section expand/collapse', () => {
    it('starts with all sections collapsed', () => {
      const state = useAgentDetailStore.getState();
      expect(state.expandedSection).toBeNull();
    });

    it('expands a section and collapses the previous one', () => {
      const { expandSection } = useAgentDetailStore.getState();
      expandSection('TOOLS');
      expect(useAgentDetailStore.getState().expandedSection).toBe('TOOLS');

      expandSection('GATHER');
      expect(useAgentDetailStore.getState().expandedSection).toBe('GATHER');
    });

    it('collapses when the same section is toggled', () => {
      const { expandSection, collapseSection } = useAgentDetailStore.getState();
      expandSection('TOOLS');
      collapseSection();
      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });
  });

  describe('IR loading', () => {
    it('parses a minimal reasoning agent IR into section models', () => {
      const minimalIR = {
        ir_version: '1.0',
        metadata: { name: 'test_agent', type: 'agent' },
        execution: { mode: 'reasoning', model: 'claude-sonnet-4-6' },
        identity: {
          goal: 'Help users',
          persona: 'Helpful assistant',
          limitations: ['No financial advice'],
        },
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            parameters: [{ name: 'query', type: 'string', required: true }],
            returns: { type: 'string' },
            hints: { cacheable: false, latency: 'fast', side_effects: false },
          },
        ],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(minimalIR, 'agent-123');

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBe('agent-123');
      expect(state.sections.identity.mode).toBe('reasoning');
      expect(state.sections.identity.goal).toBe('Help users');
      expect(state.sections.tools).toHaveLength(1);
      expect(state.sections.tools[0].name).toBe('search');
      expect(state.visibleSections).toContain('IDENTITY');
      expect(state.visibleSections).toContain('TOOLS');
      expect(state.visibleSections).not.toContain('FLOW');
    });

    it('shows FLOW section only for scripted agents', () => {
      const scriptedIR = {
        ir_version: '1.0',
        metadata: { name: 'scripted_agent', type: 'agent' },
        execution: { mode: 'scripted' },
        identity: { goal: 'Book hotels', persona: 'Booking agent', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
        flow: {
          steps: ['greet'],
          definitions: { greet: { name: 'greet', respond: 'Hello!' } },
          entry_point: 'greet',
        },
      };

      useAgentDetailStore.getState().loadFromIR(scriptedIR, 'agent-456');

      const state = useAgentDetailStore.getState();
      expect(state.visibleSections).toContain('FLOW');
      expect(state.sections.flow?.steps).toHaveLength(1);
    });

    it('hides sections that are empty', () => {
      const emptyIR = {
        ir_version: '1.0',
        metadata: { name: 'empty_agent', type: 'agent' },
        execution: { mode: 'reasoning' },
        identity: { goal: 'Do nothing', persona: '', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(emptyIR, 'agent-789');

      const state = useAgentDetailStore.getState();
      expect(state.visibleSections).toContain('IDENTITY');
      expect(state.visibleSections).not.toContain('TOOLS');
      expect(state.visibleSections).not.toContain('GATHER');
      expect(state.visibleSections).not.toContain('RULES');
      expect(state.visibleSections).not.toContain('COORDINATION');
      expect(state.visibleSections).not.toContain('LIFECYCLE');
    });
  });

  describe('save state', () => {
    it('tracks saving and saved state', () => {
      const store = useAgentDetailStore.getState();
      expect(store.saveStatus).toBe('idle');

      useAgentDetailStore.getState().setSaveStatus('saving');
      expect(useAgentDetailStore.getState().saveStatus).toBe('saving');

      useAgentDetailStore.getState().setSaveStatus('saved');
      expect(useAgentDetailStore.getState().saveStatus).toBe('saved');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      useAgentDetailStore.getState().loadFromIR(
        {
          ir_version: '1.0',
          metadata: { name: 'x', type: 'agent' },
          execution: { mode: 'reasoning' },
          identity: { goal: 'G', persona: 'P', limitations: [] },
          tools: [
            { name: 't', description: 'd', parameters: [], returns: { type: 'string' }, hints: {} },
          ],
          gather: { fields: [], strategy: 'llm' },
          memory: { session: [], persistent: [], remember: [], recall: [] },
          constraints: { constraints: [], guardrails: [] },
          coordination: { delegates: [], handoffs: [] },
          completion: { conditions: [] },
          error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
        },
        'a1',
      );

      useAgentDetailStore.getState().reset();

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBeNull();
      expect(state.sections.identity.goal).toBe('');
      expect(state.sections.tools).toHaveLength(0);
      expect(state.expandedSection).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/agent-detail-store.test.ts`
Expected: FAIL — module `../store/agent-detail-store` not found

**Step 3: Write minimal implementation**

Create `apps/studio/src/store/agent-detail-store.ts`:

```typescript
/**
 * Agent Detail Store
 *
 * Manages section states, parsed IR data, expand/collapse, and save tracking
 * for the Agent Details redesign page.
 */

import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SectionId =
  | 'IDENTITY'
  | 'TOOLS'
  | 'GATHER'
  | 'FLOW'
  | 'RULES'
  | 'COORDINATION'
  | 'LIFECYCLE';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface IdentitySectionData {
  mode: 'reasoning' | 'scripted';
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  goal: string;
  persona: string;
  limitations: string[];
  messages: Record<string, string>;
}

export interface ToolSectionData {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description?: string;
    required: boolean;
    default?: unknown;
  }>;
  returns: { type: string; fields?: Record<string, unknown> };
  hints: {
    cacheable?: boolean;
    latency?: string;
    side_effects?: boolean;
  };
  toolType?: string;
  httpBinding?: unknown;
  mcpBinding?: unknown;
  lambdaBinding?: unknown;
  sandboxBinding?: unknown;
}

export interface GatherFieldData {
  name: string;
  prompt: string;
  type: string;
  required: boolean;
  default?: unknown;
  validation?: { type: string; rule: string; error_message: string };
  extractionHints?: string[];
  infer?: boolean;
}

export interface FlowStepData {
  name: string;
  respond?: string;
  gather?: unknown;
  call?: string;
  then?: string;
  onInput?: unknown[];
  onResult?: unknown[];
  digressions?: unknown[];
  subIntents?: unknown[];
}

export interface FlowSectionData {
  steps: FlowStepData[];
  entryPoint: string | null;
  globalDigressions: unknown[];
  staticGraph: {
    nodes: Array<{ id: string; type: string; label: string }>;
    edges: Array<{ id: string; from: string; to: string; type: string; label?: string }>;
  } | null;
}

export interface ConstraintData {
  condition: string;
  onFail: { type: string; message?: string; target?: string };
}

export interface GuardrailData {
  name: string;
  description: string;
  check: string;
  action: { type: string; message?: string };
}

export interface RulesSectionData {
  constraints: ConstraintData[];
  guardrails: GuardrailData[];
}

export interface HandoffData {
  to: string;
  when: string;
  context: { pass: string[]; summary: string; history?: unknown };
  return: boolean;
}

export interface DelegateData {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  timeout?: string;
  onFailure: string;
}

export interface EscalationData {
  triggers: Array<{
    when: string;
    reason: string;
    priority: string;
    tags?: string[];
  }>;
  contextForHuman: string[];
  routing?: { queue?: string; skillTags?: string[] };
}

export interface CoordinationSectionData {
  handoffs: HandoffData[];
  delegates: DelegateData[];
  escalation: EscalationData | null;
}

export interface LifecycleSectionData {
  onStart: unknown | null;
  errorHandlers: Array<{ type: string; respond?: string; retry?: number; then: string }>;
  completion: Array<{ when: string; respond?: string }>;
  memory: {
    session: Array<{ name: string; description?: string }>;
    persistent: Array<{ path: string; access: string }>;
    remember: unknown[];
    recall: unknown[];
  };
  hooks: {
    beforeAgent?: unknown;
    afterAgent?: unknown;
    beforeTurn?: unknown;
    afterTurn?: unknown;
  };
}

export interface SectionModels {
  identity: IdentitySectionData;
  tools: ToolSectionData[];
  gather: GatherFieldData[];
  flow: FlowSectionData | null;
  rules: RulesSectionData;
  coordination: CoordinationSectionData;
  lifecycle: LifecycleSectionData;
}

interface AgentDetailState {
  // Agent identity
  agentId: string | null;
  agentName: string | null;
  agentDescription: string | null;

  // Raw IR (for reference)
  rawIR: unknown | null;

  // Parsed section data
  sections: SectionModels;

  // Which sections are visible (non-empty or always-visible)
  visibleSections: SectionId[];

  // Which section is expanded (null = all collapsed)
  expandedSection: SectionId | null;

  // Save state
  saveStatus: SaveStatus;
  saveError: string | null;

  // Actions
  loadFromIR: (ir: any, agentId: string) => void;
  expandSection: (section: SectionId) => void;
  collapseSection: () => void;
  setSaveStatus: (status: SaveStatus, error?: string) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_IDENTITY: IdentitySectionData = {
  mode: 'reasoning',
  model: null,
  temperature: null,
  maxTokens: null,
  goal: '',
  persona: '',
  limitations: [],
  messages: {},
};

const EMPTY_SECTIONS: SectionModels = {
  identity: { ...EMPTY_IDENTITY },
  tools: [],
  gather: [],
  flow: null,
  rules: { constraints: [], guardrails: [] },
  coordination: { handoffs: [], delegates: [], escalation: null },
  lifecycle: {
    onStart: null,
    errorHandlers: [],
    completion: [],
    memory: { session: [], persistent: [], remember: [], recall: [] },
    hooks: {},
  },
};

function parseIRToSections(ir: any): SectionModels {
  const identity: IdentitySectionData = {
    mode: ir.execution?.mode ?? 'reasoning',
    model: ir.execution?.model ?? null,
    temperature: ir.execution?.temperature ?? null,
    maxTokens: ir.execution?.max_tokens ?? null,
    goal: ir.identity?.goal ?? '',
    persona: ir.identity?.persona ?? '',
    limitations: ir.identity?.limitations ?? [],
    messages: ir.messages ?? {},
  };

  const tools: ToolSectionData[] = (ir.tools ?? [])
    .filter((t: any) => !t.system)
    .map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? [],
      returns: t.returns ?? { type: 'string' },
      hints: t.hints ?? {},
      toolType: t.tool_type,
      httpBinding: t.http_binding,
      mcpBinding: t.mcp_binding,
      lambdaBinding: t.lambda_binding,
      sandboxBinding: t.sandbox_binding,
    }));

  const gather: GatherFieldData[] = (ir.gather?.fields ?? []).map((f: any) => ({
    name: f.name,
    prompt: f.prompt ?? '',
    type: f.type ?? 'string',
    required: f.required ?? false,
    default: f.default,
    validation: f.validation,
    extractionHints: f.extraction_hints,
    infer: f.infer,
  }));

  let flow: FlowSectionData | null = null;
  if (ir.flow && ir.execution?.mode === 'scripted') {
    const stepNames = ir.flow.steps ?? [];
    const defs = ir.flow.definitions ?? {};
    flow = {
      steps: stepNames.map((name: string) => {
        const def = defs[name] ?? {};
        return {
          name,
          respond: def.respond,
          gather: def.gather,
          call: def.call,
          then: def.then,
          onInput: def.on_input,
          onResult: def.on_result,
          digressions: def.digressions,
          subIntents: def.sub_intents,
        };
      }),
      entryPoint: ir.flow.entry_point ?? null,
      globalDigressions: ir.flow.global_digressions ?? [],
      staticGraph: ir.flow.staticGraph ?? null,
    };
  }

  const rules: RulesSectionData = {
    constraints: (ir.constraints?.constraints ?? []).map((c: any) => ({
      condition: c.condition,
      onFail: c.on_fail ?? { type: 'respond' },
    })),
    guardrails: (ir.constraints?.guardrails ?? []).map((g: any) => ({
      name: g.name,
      description: g.description ?? '',
      check: g.check,
      action: g.action ?? { type: 'block' },
    })),
  };

  const coordination: CoordinationSectionData = {
    handoffs: (ir.coordination?.handoffs ?? []).map((h: any) => ({
      to: h.to,
      when: h.when,
      context: h.context ?? { pass: [], summary: '' },
      return: h.return ?? false,
    })),
    delegates: (ir.coordination?.delegates ?? []).map((d: any) => ({
      agent: d.agent,
      when: d.when,
      purpose: d.purpose ?? '',
      input: d.input ?? {},
      returns: d.returns ?? {},
      timeout: d.timeout,
      onFailure: d.on_failure ?? 'continue',
    })),
    escalation: ir.coordination?.escalation
      ? {
          triggers: ir.coordination.escalation.triggers ?? [],
          contextForHuman: ir.coordination.escalation.context_for_human ?? [],
          routing: ir.coordination.escalation.routing,
        }
      : null,
  };

  const lifecycle: LifecycleSectionData = {
    onStart: ir.on_start ?? null,
    errorHandlers: (ir.error_handling?.handlers ?? []).map((h: any) => ({
      type: h.type,
      respond: h.respond,
      retry: h.retry,
      then: h.then ?? 'continue',
    })),
    completion: (ir.completion?.conditions ?? []).map((c: any) => ({
      when: c.when,
      respond: c.respond,
    })),
    memory: {
      session: ir.memory?.session ?? [],
      persistent: ir.memory?.persistent ?? [],
      remember: ir.memory?.remember ?? [],
      recall: ir.memory?.recall ?? [],
    },
    hooks: {
      beforeAgent: ir.hooks?.before_agent,
      afterAgent: ir.hooks?.after_agent,
      beforeTurn: ir.hooks?.before_turn,
      afterTurn: ir.hooks?.after_turn,
    },
  };

  return { identity, tools, gather, flow, rules, coordination, lifecycle };
}

function computeVisibleSections(sections: SectionModels): SectionId[] {
  const visible: SectionId[] = ['IDENTITY']; // Always visible

  if (sections.tools.length > 0) visible.push('TOOLS');
  if (sections.gather.length > 0) visible.push('GATHER');
  if (sections.flow !== null) visible.push('FLOW');
  if (sections.rules.constraints.length > 0 || sections.rules.guardrails.length > 0)
    visible.push('RULES');
  if (
    sections.coordination.handoffs.length > 0 ||
    sections.coordination.delegates.length > 0 ||
    sections.coordination.escalation !== null
  )
    visible.push('COORDINATION');

  const lc = sections.lifecycle;
  if (
    lc.onStart !== null ||
    lc.errorHandlers.length > 0 ||
    lc.completion.length > 0 ||
    lc.memory.session.length > 0 ||
    lc.memory.persistent.length > 0 ||
    lc.memory.remember.length > 0 ||
    Object.values(lc.hooks).some((h) => h != null)
  )
    visible.push('LIFECYCLE');

  return visible;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAgentDetailStore = create<AgentDetailState>()((set) => ({
  agentId: null,
  agentName: null,
  agentDescription: null,
  rawIR: null,
  sections: { ...EMPTY_SECTIONS },
  visibleSections: ['IDENTITY'],
  expandedSection: null,
  saveStatus: 'idle' as SaveStatus,
  saveError: null,

  loadFromIR: (ir, agentId) => {
    const sections = parseIRToSections(ir);
    const visibleSections = computeVisibleSections(sections);
    set({
      agentId,
      agentName: ir.metadata?.name ?? null,
      rawIR: ir,
      sections,
      visibleSections,
      expandedSection: null,
      saveStatus: 'idle',
      saveError: null,
    });
  },

  expandSection: (section) => set({ expandedSection: section }),

  collapseSection: () => set({ expandedSection: null }),

  setSaveStatus: (status, error) => set({ saveStatus: status, saveError: error ?? null }),

  reset: () =>
    set({
      agentId: null,
      agentName: null,
      agentDescription: null,
      rawIR: null,
      sections: { ...EMPTY_SECTIONS, identity: { ...EMPTY_IDENTITY } },
      visibleSections: ['IDENTITY'],
      expandedSection: null,
      saveStatus: 'idle',
      saveError: null,
    }),
}));
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/agent-detail-store.test.ts`
Expected: PASS — all tests green

**Step 5: Commit**

```bash
git add apps/studio/src/store/agent-detail-store.ts apps/studio/src/__tests__/agent-detail-store.test.ts
git commit -m "[ABLP-2] feat(studio): add agent-detail-store for section state management"
```

---

## Task 2: Add editContext to arch-store

Wire Arch AI to track which section is currently expanded so it can provide contextual suggestions.

**Files:**

- Modify: `apps/studio/src/types/arch.ts`
- Modify: `apps/studio/src/store/arch-store.ts`
- Modify: `apps/studio/src/__tests__/arch-components.test.tsx` (or create new test)
- Test: `apps/studio/src/__tests__/arch-edit-context.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/arch-edit-context.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useArchStore } from '../store/arch-store';

describe('arch-store editContext', () => {
  beforeEach(() => {
    // Reset just the editContext-related state
    useArchStore.getState().setEditContext(null);
  });

  it('starts with null editContext', () => {
    const state = useArchStore.getState();
    expect(state.editContext).toBeNull();
  });

  it('sets editContext with section and agent info', () => {
    useArchStore.getState().setEditContext({
      section: 'TOOLS',
      agentId: 'agent-123',
      currentContent: [{ name: 'search', description: 'Search' }],
      siblingContext: {
        mode: 'reasoning',
        goal: 'Help users',
        toolNames: ['search'],
        gatherFieldNames: [],
        flowStepNames: [],
      },
    });

    const state = useArchStore.getState();
    expect(state.editContext).not.toBeNull();
    expect(state.editContext!.section).toBe('TOOLS');
    expect(state.editContext!.agentId).toBe('agent-123');
    expect(state.editContext!.siblingContext.toolNames).toEqual(['search']);
  });

  it('clears editContext when set to null', () => {
    useArchStore.getState().setEditContext({
      section: 'IDENTITY',
      agentId: 'a1',
      currentContent: {},
      siblingContext: {
        mode: 'reasoning',
        goal: '',
        toolNames: [],
        gatherFieldNames: [],
        flowStepNames: [],
      },
    });

    useArchStore.getState().setEditContext(null);
    expect(useArchStore.getState().editContext).toBeNull();
  });

  it('returns section-specific suggestions', () => {
    const chips = useArchStore.getState().getSuggestionsForSection('TOOLS');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some((c) => c.label.toLowerCase().includes('tool'))).toBe(true);
  });

  it('returns generic suggestions for null section', () => {
    const chips = useArchStore.getState().getSuggestionsForSection(null);
    expect(chips.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-edit-context.test.ts`
Expected: FAIL — `setEditContext` and `editContext` not found on arch store

**Step 3: Write the implementation**

Add to `apps/studio/src/types/arch.ts` (append before the closing of the file):

```typescript
export type AgentSectionId =
  | 'IDENTITY'
  | 'TOOLS'
  | 'GATHER'
  | 'FLOW'
  | 'RULES'
  | 'COORDINATION'
  | 'LIFECYCLE';

export interface ArchEditContext {
  section: AgentSectionId;
  agentId: string;
  currentContent: unknown;
  siblingContext: {
    mode: string;
    goal: string;
    toolNames: string[];
    gatherFieldNames: string[];
    flowStepNames: string[];
  };
}
```

Add to `apps/studio/src/store/arch-store.ts`:

1. Import `ArchEditContext` from types
2. Add `editContext: ArchEditContext | null` to state (initialize as `null`)
3. Add `setEditContext: (ctx: ArchEditContext | null) => void` action
4. Add `getSuggestionsForSection: (section: AgentSectionId | null) => ArchSuggestion[]` action
5. Exclude `editContext` from persistence (add to `partialize` exclusion list alongside `pendingDiffs`)

The `getSuggestionsForSection` implementation maps sections to suggestion chips:

```typescript
const SECTION_SUGGESTIONS: Record<string, ArchSuggestion[]> = {
  IDENTITY: [
    {
      id: 'refine-persona',
      label: 'Refine persona',
      description: 'Improve the agent persona',
      category: 'optimization',
      prompt: 'Help me refine the persona for this agent',
    },
    {
      id: 'add-limitations',
      label: 'Add limitations',
      description: 'Add safety limitations',
      category: 'security',
      prompt: 'Suggest limitations for this agent',
    },
    {
      id: 'switch-mode',
      label: 'Switch to scripted',
      description: 'Convert to scripted mode',
      category: 'feature',
      prompt: 'Convert this agent to scripted mode',
    },
  ],
  TOOLS: [
    {
      id: 'add-tool',
      label: 'Add a tool',
      description: 'Define a new tool',
      category: 'feature',
      prompt: 'Help me add a new tool to this agent',
    },
    {
      id: 'configure-auth',
      label: 'Configure auth',
      description: 'Set up tool authentication',
      category: 'security',
      prompt: 'Help me configure authentication for my tools',
    },
    {
      id: 'add-error-handling',
      label: 'Add error handling',
      description: 'Add tool error handling',
      category: 'error-handling',
      prompt: 'Add error handling for the tools',
    },
  ],
  GATHER: [
    {
      id: 'add-field',
      label: 'Add a field',
      description: 'Add a gather field',
      category: 'feature',
      prompt: 'Help me add a new gather field',
    },
    {
      id: 'add-validation',
      label: 'Add validation',
      description: 'Add field validation rules',
      category: 'optimization',
      prompt: 'Add validation rules to the gather fields',
    },
  ],
  FLOW: [
    {
      id: 'add-step',
      label: 'Add a step',
      description: 'Add a flow step',
      category: 'feature',
      prompt: 'Help me add a new flow step',
    },
    {
      id: 'add-digression',
      label: 'Add digression',
      description: 'Handle off-topic input',
      category: 'feature',
      prompt: 'Add a digression handler',
    },
    {
      id: 'add-on-input',
      label: 'Add ON_INPUT handler',
      description: 'Branch on user input',
      category: 'feature',
      prompt: 'Add an ON_INPUT handler to a step',
    },
  ],
  RULES: [
    {
      id: 'add-guardrail',
      label: 'Add guardrail',
      description: 'Add a safety guardrail',
      category: 'security',
      prompt: 'Suggest guardrails for this agent',
    },
    {
      id: 'add-constraint',
      label: 'Add constraint',
      description: 'Add a constraint',
      category: 'security',
      prompt: 'Help me add a constraint',
    },
    {
      id: 'tighten-rules',
      label: 'Tighten rules',
      description: 'Review and strengthen rules',
      category: 'optimization',
      prompt: 'Review my constraints and suggest improvements',
    },
  ],
  COORDINATION: [
    {
      id: 'add-handoff',
      label: 'Add handoff',
      description: 'Hand off to another agent',
      category: 'feature',
      prompt: 'Help me add a handoff to another agent',
    },
    {
      id: 'configure-escalation',
      label: 'Configure escalation',
      description: 'Set up human escalation',
      category: 'escalation',
      prompt: 'Configure human escalation for this agent',
    },
    {
      id: 'add-delegation',
      label: 'Add delegation',
      description: 'Delegate tasks to other agents',
      category: 'feature',
      prompt: 'Help me set up delegation',
    },
  ],
  LIFECYCLE: [
    {
      id: 'add-greeting',
      label: 'Add greeting',
      description: 'Set up ON_START greeting',
      category: 'feature',
      prompt: 'Add a greeting message on start',
    },
    {
      id: 'configure-memory',
      label: 'Configure memory',
      description: 'Set up agent memory',
      category: 'feature',
      prompt: 'Help me configure memory for this agent',
    },
    {
      id: 'add-error-handler',
      label: 'Add error handler',
      description: 'Handle specific errors',
      category: 'error-handling',
      prompt: 'Add error handlers for this agent',
    },
  ],
  DEFAULT: [
    {
      id: 'improve-agent',
      label: 'Improve this agent',
      description: 'General improvement suggestions',
      category: 'optimization',
      prompt: 'Review this agent and suggest improvements',
    },
    {
      id: 'review-config',
      label: 'Review my config',
      description: 'Check for issues',
      category: 'optimization',
      prompt: "Review this agent's configuration for issues",
    },
    {
      id: 'whats-missing',
      label: "What's missing?",
      description: 'Find gaps',
      category: 'optimization',
      prompt: "What's missing from this agent's configuration?",
    },
  ],
};
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-edit-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/types/arch.ts apps/studio/src/store/arch-store.ts apps/studio/src/__tests__/arch-edit-context.test.ts
git commit -m "[ABLP-2] feat(studio): add editContext and section suggestions to arch-store"
```

---

## Task 3: Create SectionCard wrapper component

A reusable collapsible card component used by all 7 sections. Handles expand/collapse animation, the Arch [✦] button, save status indicator, and empty section prompts.

**Files:**

- Create: `apps/studio/src/components/agent-detail/SectionCard.tsx`
- Create: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/section-card.test.tsx`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/section-card.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionCard } from '../components/agent-detail/SectionCard';

describe('SectionCard', () => {
  it('renders collapsed with title and summary', () => {
    render(
      <SectionCard
        title="Tools"
        sectionId="TOOLS"
        count={3}
        isExpanded={false}
        onToggle={() => {}}
        summary={<span>search, verify, cancel</span>}
      >
        <div>Editor content</div>
      </SectionCard>
    );

    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('search, verify, cancel')).toBeInTheDocument();
    expect(screen.queryByText('Editor content')).not.toBeInTheDocument();
  });

  it('renders expanded with children', () => {
    render(
      <SectionCard
        title="Tools"
        sectionId="TOOLS"
        count={3}
        isExpanded={true}
        onToggle={() => {}}
        summary={<span>search, verify, cancel</span>}
      >
        <div>Editor content</div>
      </SectionCard>
    );

    expect(screen.getByText('Editor content')).toBeInTheDocument();
  });

  it('calls onToggle when header is clicked', () => {
    const onToggle = vi.fn();
    render(
      <SectionCard
        title="Rules"
        sectionId="RULES"
        count={2}
        isExpanded={false}
        onToggle={onToggle}
        summary={<span>2 constraints</span>}
      >
        <div>Rules editor</div>
      </SectionCard>
    );

    fireEvent.click(screen.getByText('Rules'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('calls onArchClick when arch button is clicked', () => {
    const onArchClick = vi.fn();
    render(
      <SectionCard
        title="Tools"
        sectionId="TOOLS"
        count={1}
        isExpanded={false}
        onToggle={() => {}}
        onArchClick={onArchClick}
        summary={<span>search</span>}
      >
        <div>content</div>
      </SectionCard>
    );

    const archButton = screen.getByLabelText('Ask Arch about Tools');
    fireEvent.click(archButton);
    expect(onArchClick).toHaveBeenCalled();
  });

  it('shows save status when expanded', () => {
    render(
      <SectionCard
        title="Identity"
        sectionId="IDENTITY"
        isExpanded={true}
        onToggle={() => {}}
        saveStatus="saved"
      >
        <div>Editor</div>
      </SectionCard>
    );

    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('renders empty state when isEmpty is true', () => {
    render(
      <SectionCard
        title="Rules"
        sectionId="RULES"
        isEmpty={true}
        isExpanded={false}
        onToggle={() => {}}
        onArchClick={() => {}}
      >
        <div>Editor</div>
      </SectionCard>
    );

    expect(screen.getByText(/No rules defined/i)).toBeInTheDocument();
    expect(screen.getByText(/Ask Arch to suggest/i)).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/section-card.test.tsx`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `apps/studio/src/components/agent-detail/SectionCard.tsx`:

```typescript
'use client';

import { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Sparkles, Check, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { SectionId, SaveStatus } from '@/store/agent-detail-store';
import { springs } from '@/lib/animation';

interface SectionCardProps {
  title: string;
  sectionId: SectionId;
  count?: number;
  isExpanded: boolean;
  onToggle: () => void;
  onArchClick?: () => void;
  summary?: ReactNode;
  children: ReactNode;
  saveStatus?: SaveStatus;
  isEmpty?: boolean;
  className?: string;
}

const SECTION_EMPTY_LABELS: Record<string, string> = {
  TOOLS: 'No tools defined',
  GATHER: 'No gather fields defined',
  FLOW: 'No flow steps defined',
  RULES: 'No rules defined',
  COORDINATION: 'No coordination configured',
  LIFECYCLE: 'No lifecycle hooks configured',
};

export function SectionCard({
  title,
  sectionId,
  count,
  isExpanded,
  onToggle,
  onArchClick,
  summary,
  children,
  saveStatus,
  isEmpty,
  className,
}: SectionCardProps) {
  const ChevronIcon = isExpanded ? ChevronUp : ChevronDown;

  return (
    <div
      className={clsx(
        'rounded-xl border bg-background-elevated transition-default',
        isExpanded ? 'border-accent/30 shadow-md' : 'border-default shadow-sm',
        className,
      )}
    >
      {/* Header — always visible */}
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'flex w-full items-center justify-between px-4 py-3 text-left',
          'transition-default hover:bg-background-muted/50 rounded-xl',
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {count != null && count > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-accent-subtle text-accent text-xs font-medium px-1.5 min-w-[20px] h-5">
              {count}
            </span>
          )}
          {!isExpanded && summary && (
            <span className="text-xs text-muted truncate ml-1">{summary}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isExpanded && saveStatus && (
            <SaveIndicator status={saveStatus} />
          )}
          {onArchClick && (
            <span
              role="button"
              aria-label={`Ask Arch about ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onArchClick();
              }}
              className="p-1 rounded-md text-purple hover:bg-purple/10 transition-fast"
            >
              <Sparkles className="w-3.5 h-3.5" />
            </span>
          )}
          <ChevronIcon className="w-4 h-4 text-muted" />
        </div>
      </button>

      {/* Empty state (shown collapsed) */}
      {isEmpty && !isExpanded && (
        <div className="px-4 pb-3 -mt-1">
          <p className="text-xs text-subtle">
            {SECTION_EMPTY_LABELS[sectionId] ?? 'Empty'}.{' '}
            {onArchClick && (
              <button
                type="button"
                onClick={onArchClick}
                className="text-purple hover:underline"
              >
                Ask Arch to suggest &rarr;
              </button>
            )}
          </p>
        </div>
      )}

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.gentle}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 border-t border-default/50">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted">
        <Loader2 className="w-3 h-3 animate-spin" />
        Saving...
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <Check className="w-3 h-3" />
        Saved
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="text-xs text-error">Save failed</span>
    );
  }
  return null;
}
```

Create `apps/studio/src/components/agent-detail/index.ts`:

```typescript
export { SectionCard } from './SectionCard';
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/section-card.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/agent-detail/SectionCard.tsx apps/studio/src/components/agent-detail/index.ts apps/studio/src/__tests__/section-card.test.tsx
git commit -m "[ABLP-2] feat(studio): add SectionCard collapsible wrapper component"
```

---

## Task 4: Create IdentitySection component

The always-visible section showing agent mode, model, goal, persona, limitations. Inline-editable when expanded.

**Files:**

- Create: `apps/studio/src/components/agent-detail/IdentitySection.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts` (add export)
- Test: `apps/studio/src/__tests__/identity-section.test.tsx`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/identity-section.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IdentitySection } from '../components/agent-detail/IdentitySection';

const mockData = {
  mode: 'reasoning' as const,
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096,
  goal: 'Help users book hotels',
  persona: 'You are a friendly hotel booking assistant.',
  limitations: ['Cannot process payments', 'No refunds'],
  messages: {},
};

describe('IdentitySection', () => {
  it('renders collapsed summary with mode badge, model name, goal preview', () => {
    render(
      <IdentitySection
        data={mockData}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />
    );

    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText(/reasoning/i)).toBeInTheDocument();
  });

  it('renders expanded form with goal textarea', () => {
    render(
      <IdentitySection
        data={mockData}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />
    );

    const goalTextarea = screen.getByLabelText('Goal');
    expect(goalTextarea).toBeInTheDocument();
    expect(goalTextarea).toHaveValue('Help users book hotels');
  });

  it('calls onChange when goal is edited', () => {
    const onChange = vi.fn();
    render(
      <IdentitySection
        data={mockData}
        isExpanded={true}
        onToggle={() => {}}
        onChange={onChange}
      />
    );

    const goalTextarea = screen.getByLabelText('Goal');
    fireEvent.change(goalTextarea, { target: { value: 'Help users book flights' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goal: 'Help users book flights' }));
  });

  it('renders mode dropdown in expanded state', () => {
    render(
      <IdentitySection
        data={mockData}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />
    );

    expect(screen.getByLabelText('Execution Mode')).toBeInTheDocument();
  });

  it('renders limitations as removable tags', () => {
    render(
      <IdentitySection
        data={mockData}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />
    );

    expect(screen.getByText('Cannot process payments')).toBeInTheDocument();
    expect(screen.getByText('No refunds')).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/identity-section.test.tsx`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `apps/studio/src/components/agent-detail/IdentitySection.tsx`. The component:

- Wraps `SectionCard` with title "Identity" (always visible)
- Collapsed summary: mode badge + model name + goal first line
- Expanded form: Goal textarea, Persona textarea, Limitations tag list with add/remove, Mode dropdown (Reasoning/Scripted), Model dropdown (placeholder until project models loaded), Temperature slider with override toggle, Max tokens input with override toggle, Messages collapsible sub-section
- Calls `onChange(updatedData)` on any field change

Use existing UI components: `Select`, `Textarea`, `Input`, `Badge`.

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/identity-section.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/agent-detail/IdentitySection.tsx apps/studio/src/components/agent-detail/index.ts apps/studio/src/__tests__/identity-section.test.tsx
git commit -m "[ABLP-2] feat(studio): add IdentitySection form editor component"
```

---

## Task 5: Create ToolsSection component

Shows tool cards with name, description, parameters table, binding config, and hints.

**Files:**

- Create: `apps/studio/src/components/agent-detail/ToolsSection.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/tools-section.test.tsx`

**Step 1: Write the failing test**

Test that collapsed state shows tool count + name chips with binding badges. Test that expanded state shows tool cards with parameters table. Test that [+ Add Tool] button is visible in expanded state.

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/tools-section.test.tsx`
Expected: FAIL

**Step 3: Write implementation**

The ToolsSection component:

- Collapsed summary: tool count, tool name chips with binding type badges (HTTP/MCP/Lambda/Sandbox)
- Expanded: Card per tool with name, description, typed parameters table (name, type, required, default), return type, binding config per card, tool hints toggles
- [+ Add Tool] button at bottom
- Each tool card has expand/collapse for its binding config details
- Uses `SectionCard` wrapper

**Step 4: Run test, Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): add ToolsSection form editor component"
```

---

## Task 6: Create GatherSection component

Shows gather field table with inline editing.

**Files:**

- Create: `apps/studio/src/components/agent-detail/GatherSection.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/gather-section.test.tsx`

**Step 1: Write test**

Test collapsed summary shows field count + field name pills (filled=required, outlined=optional). Test expanded shows table with Field name, Type, Required toggle, Prompt, Default columns. Test [+ Add Field] adds an inline row.

**Step 2-4: Run, implement, verify**

**Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): add GatherSection form editor component"
```

---

## Task 7: Create FlowSection component with mini-graph

The most complex section — shows a read-only flow graph and step editors below.

**Files:**

- Create: `apps/studio/src/components/agent-detail/FlowSection.tsx`
- Create: `apps/studio/src/components/agent-detail/FlowMiniGraph.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/flow-section.test.tsx`

**Step 1: Write test**

Test collapsed shows step count + mini flow graph placeholder. Test expanded shows read-only flow graph at top + step list below. Test that clicking a graph node scrolls to the step editor. Test that step editors show name, prompt/RESPOND text, CALL actions, THEN transition.

**Step 2-4: Run, implement, verify**

The `FlowMiniGraph` component:

- Takes `staticGraph` from IR (nodes + edges) or constructs basic graph from step definitions
- Renders nodes as boxes, edges as lines/arrows
- Uses SVG rendering (like TopologyCanvas) — NOT full ReactFlow, to keep it lightweight
- Nodes show step name, edges show transition labels
- Click handler on nodes emits `onStepClick(stepName)` for scrolling

The `FlowSection` component:

- Wraps `SectionCard` with title "Flow"
- Collapsed: step count + `FlowMiniGraph` in compact mode
- Expanded: Full `FlowMiniGraph` at top + step editor list below
- Each step editor: name field, respond/prompt text, gather field refs, call action, then transition dropdown, on_input branches, on_result branches, sub-intents, step-level digressions
- [+ Add Step] button
- Global digressions section at bottom

**Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): add FlowSection with mini-graph and step editors"
```

---

## Task 8: Create RulesSection component

Shows constraints and guardrails.

**Files:**

- Create: `apps/studio/src/components/agent-detail/RulesSection.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/rules-section.test.tsx`

**Step 1: Write test**

Test collapsed shows constraint count + guardrail count. Test expanded shows constraints sub-section with condition + on_fail action per row. Test guardrails sub-section with name + check + action per row. Test [+ Add Constraint] and [+ Add Guardrail] buttons.

**Step 2-5: Implement, verify, commit**

```bash
git commit -m "[ABLP-2] feat(studio): add RulesSection form editor component"
```

---

## Task 9: Create CoordinationSection component

Shows handoffs, delegation, and escalation config.

**Files:**

- Create: `apps/studio/src/components/agent-detail/CoordinationSection.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/coordination-section.test.tsx`

**Step 1: Write test**

Test collapsed shows counts per type with target agent names. Test expanded shows handoffs with target agent, WHEN condition, context fields, history strategy. Test delegation with target agent, INPUT/RETURNS mapping, timeout. Test escalation with triggers, priority, routing config.

**Step 2-5: Implement, verify, commit**

```bash
git commit -m "[ABLP-2] feat(studio): add CoordinationSection form editor component"
```

---

## Task 10: Create LifecycleSection component

Shows ON_START, ON_ERROR, COMPLETE, Memory, and Hooks.

**Files:**

- Create: `apps/studio/src/components/agent-detail/LifecycleSection.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/lifecycle-section.test.tsx`

**Step 1: Write test**

Test collapsed shows hook count + completion condition preview. Test expanded shows ON_START action list, ON_ERROR per-type rows, COMPLETE when-condition, Memory session/persistent vars, Hooks before_agent/after_agent/before_turn/after_turn.

**Step 2-5: Implement, verify, commit**

```bash
git commit -m "[ABLP-2] feat(studio): add LifecycleSection form editor component"
```

---

## Task 11: Create useAgentIR hook (fetch DSL + compile to IR)

Custom SWR hook that fetches the agent's DSL, compiles it to IR via the `/api/abl/compile` endpoint, and loads it into the agent-detail-store.

**Files:**

- Create: `apps/studio/src/hooks/useAgentIR.ts`
- Test: `apps/studio/src/__tests__/agent-ir-hook.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock apiFetch before importing the hook
const mockApiFetch = vi.fn();
vi.mock('../lib/api-client', () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
  handleResponse: (r: any) => r.json(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import { useAgentIR } from '../hooks/useAgentIR';

describe('useAgentIR', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('returns null IR when projectId or agentName is missing', () => {
    const { result } = renderHook(() => useAgentIR(null, null));
    expect(result.current.ir).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches agent DSL and compiles to IR', async () => {
    // Mock fetching agent
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/booking')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'AGENT: booking\nMODE: reasoning' } }),
        });
      }
      if (url.includes('/abl/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ir: {
                ir_version: '1.0',
                metadata: { name: 'booking' },
                execution: { mode: 'reasoning' },
                identity: { goal: '', persona: '', limitations: [] },
                tools: [],
                gather: { fields: [] },
              },
              errors: [],
            }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderHook(() => useAgentIR('proj-1', 'booking'));

    await waitFor(() => {
      expect(result.current.ir).not.toBeNull();
    });

    expect(result.current.ir?.metadata?.name).toBe('booking');
    expect(result.current.compileErrors).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/agent-ir-hook.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `apps/studio/src/hooks/useAgentIR.ts`:

```typescript
/**
 * useAgentIR Hook
 *
 * Fetches agent DSL, compiles to IR via /api/abl/compile,
 * and loads parsed sections into agent-detail-store.
 */

import useSWR from 'swr';
import { apiFetch, handleResponse } from '@/lib/api-client';
import { useAgentDetailStore } from '@/store/agent-detail-store';

interface CompileResponse {
  success: boolean;
  ir: any | null;
  errors: string[];
}

async function fetchAndCompile(projectId: string, agentName: string) {
  // 1. Fetch agent DSL
  const agentRes = await apiFetch(
    `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
  );
  const { agent } = await handleResponse<{ agent: { dslContent: string | null } }>(agentRes);

  if (!agent.dslContent) {
    return { ir: null, dsl: '', errors: ['Agent has no DSL content'] };
  }

  // 2. Compile DSL to IR
  const compileRes = await apiFetch('/api/abl/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dsl: agent.dslContent }),
  });
  const compileData = await handleResponse<CompileResponse>(compileRes);

  return {
    ir: compileData.ir,
    dsl: agent.dslContent,
    errors: compileData.errors ?? [],
  };
}

export function useAgentIR(projectId: string | null, agentName: string | null) {
  const loadFromIR = useAgentDetailStore((s) => s.loadFromIR);

  const key = projectId && agentName ? (['agent-ir', projectId, agentName] as const) : null;

  const { data, error, isLoading, mutate } = useSWR(
    key,
    () => fetchAndCompile(projectId!, agentName!),
    {
      revalidateOnFocus: false,
      onSuccess: (result) => {
        if (result.ir) {
          loadFromIR(result.ir, `${projectId}/${agentName}`);
        }
      },
    },
  );

  return {
    ir: data?.ir ?? null,
    dsl: data?.dsl ?? '',
    compileErrors: data?.errors ?? [],
    isLoading,
    error: error ? String(error) : null,
    reload: () => mutate(),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/agent-ir-hook.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/hooks/useAgentIR.ts apps/studio/src/__tests__/agent-ir-hook.test.ts
git commit -m "[ABLP-2] feat(studio): add useAgentIR hook for DSL fetch + compile"
```

---

## Task 12: Create useSectionEdit hook (debounced auto-save via surgical edit API)

Hook that debounces section form changes and sends them to the surgical edit API.

**Files:**

- Create: `apps/studio/src/hooks/useSectionEdit.ts`
- Test: `apps/studio/src/__tests__/section-edit-hook.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockApiFetch = vi.fn();
vi.mock('../lib/api-client', () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
  handleResponse: (r: any) => r.json(),
}));

vi.useFakeTimers();

import { useSectionEdit } from '../hooks/useSectionEdit';

describe('useSectionEdit', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ dslContent: 'updated', diff: {} }),
    });
  });

  it('debounces edits and calls surgical edit API after 500ms', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'TOOLS:\n  search:\n    ...');
    });

    // Should not have called API yet
    expect(mockApiFetch).not.toHaveBeenCalled();

    // Advance timer past debounce
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/agents/booking/edit',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('TOOLS'),
      }),
    );
  });

  it('coalesces multiple rapid edits into one API call', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'version 1');
      result.current.editSection('TOOLS', 'version 2');
      result.current.editSection('TOOLS', 'version 3');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    // Only called once with the last version
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.stringContaining('version 3'),
      }),
    );
  });
});
```

**Step 2: Run test, Step 3: Implement**

Create `apps/studio/src/hooks/useSectionEdit.ts`:

```typescript
/**
 * useSectionEdit Hook
 *
 * Debounces section form changes (500ms) and sends them
 * to the surgical edit API. Updates save status in agent-detail-store.
 */

import { useCallback, useRef } from 'react';
import { apiFetch, handleResponse } from '@/lib/api-client';
import { useAgentDetailStore } from '@/store/agent-detail-store';

const DEBOUNCE_MS = 500;

interface EditResponse {
  dslContent: string;
  diff: unknown;
}

export function useSectionEdit(projectId: string | null, agentName: string | null) {
  const setSaveStatus = useAgentDetailStore((s) => s.setSaveStatus);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ section: string; content: string } | null>(null);

  const flush = useCallback(async () => {
    if (!projectId || !agentName || !pendingRef.current) return;

    const { section, content } = pendingRef.current;
    pendingRef.current = null;

    setSaveStatus('saving');
    try {
      const res = await apiFetch(`/api/projects/${projectId}/agents/${agentName}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: [{ section, content }] }),
      });
      await handleResponse<EditResponse>(res);
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err instanceof Error ? err.message : 'Save failed');
    }
  }, [projectId, agentName, setSaveStatus]);

  const editSection = useCallback(
    (section: string, content: string) => {
      pendingRef.current = { section, content };

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );

  return { editSection };
}
```

**Step 4: Run test, Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): add useSectionEdit hook with debounced auto-save"
```

---

## Task 13: Rewrite AgentDetailPage as single scrollable page

Replace the current 5-tab `AgentDetailPage` with the new single scrollable page that renders all section cards. This is the main integration task — wires together the store, hook, and section components.

**Files:**

- Modify: `apps/studio/src/components/agents/AgentDetailPage.tsx` (rewrite)
- Test: `apps/studio/src/__tests__/agent-detail-page.test.tsx`

**Step 1: Write integration test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock hooks and stores
vi.mock('../hooks/useAgentIR', () => ({
  useAgentIR: () => ({
    ir: {
      metadata: { name: 'booking_agent' },
      execution: { mode: 'reasoning', model: 'claude-sonnet-4-6' },
      identity: { goal: 'Help users book hotels', persona: 'Friendly assistant', limitations: [] },
      tools: [{ name: 'search_hotels', description: 'Search', parameters: [], returns: { type: 'object' }, hints: {} }],
      gather: { fields: [{ name: 'destination', type: 'string', required: true, prompt: 'Where?' }] },
      constraints: { constraints: [], guardrails: [] },
      coordination: { delegates: [], handoffs: [] },
      completion: { conditions: [] },
      error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      memory: { session: [], persistent: [], remember: [], recall: [] },
    },
    dsl: 'AGENT: booking_agent',
    compileErrors: [],
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../store/navigation-store', () => ({
  useNavigationStore: () => ({
    projectId: 'proj-1',
    subPage: 'booking_agent',
    navigate: vi.fn(),
  }),
}));

vi.mock('../store/arch-store', () => ({
  useArchStore: Object.assign(vi.fn(() => ({
    isOpen: false,
    setContext: vi.fn(),
    setEditContext: vi.fn(),
    openPanel: vi.fn(),
  })), { getState: () => ({ setContext: vi.fn(), setEditContext: vi.fn() }) }),
}));

import { AgentDetailPage } from '../components/agents/AgentDetailPage';

describe('AgentDetailPage (redesigned)', () => {
  it('renders agent name in header', () => {
    render(<AgentDetailPage />);
    expect(screen.getByText('booking_agent')).toBeInTheDocument();
  });

  it('renders Identity section (always visible)', () => {
    render(<AgentDetailPage />);
    expect(screen.getByText('Identity')).toBeInTheDocument();
  });

  it('renders Tools section when tools exist', () => {
    render(<AgentDetailPage />);
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });

  it('renders Gather section when fields exist', () => {
    render(<AgentDetailPage />);
    expect(screen.getByText('Gather Fields')).toBeInTheDocument();
  });

  it('does not render Flow section for reasoning agents', () => {
    render(<AgentDetailPage />);
    expect(screen.queryByText('Flow')).not.toBeInTheDocument();
  });

  it('renders header actions: Versions, DSL, Chat', () => {
    render(<AgentDetailPage />);
    expect(screen.getByText('Versions')).toBeInTheDocument();
    expect(screen.getByText('DSL')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/agent-detail-page.test.tsx`
Expected: FAIL — current AgentDetailPage has different structure

**Step 3: Rewrite AgentDetailPage.tsx**

The new component structure:

```
AgentDetailPage
├── Header
│   ├── Back button ("← Agents")
│   ├── Inline-editable agent name + description
│   ├── Metadata line (mode badge, model name, version)
│   └── Header actions: [Versions] [DSL] [Chat]
├── Section cards (scrollable)
│   ├── IdentitySection (always visible)
│   ├── ToolsSection (if tools.length > 0)
│   ├── GatherSection (if gather.length > 0)
│   ├── FlowSection (if scripted mode)
│   ├── RulesSection (if constraints/guardrails exist)
│   ├── CoordinationSection (if handoffs/delegates/escalation exist)
│   └── LifecycleSection (if hooks/memory/completion exist)
└── Arch floating pill (right edge)
```

Key wiring:

- Uses `useAgentIR(projectId, agentName)` to load IR
- Uses `useAgentDetailStore()` for section state
- Uses `useSectionEdit(projectId, agentName)` for auto-save
- Expanding a section updates `arch-store.editContext`
- [✦] button on each section opens Arch panel pre-focused on that section
- Header actions open slide-overs/overlays (reuse existing VersionListTab, DslEditorTab, ChatWithDebugPanel)

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): rewrite AgentDetailPage as single scrollable page with section cards"
```

---

## Task 14: Create header action overlays (Versions, DSL, Chat slide-overs)

Move the existing tab content into slide-over/overlay components accessed from header buttons.

**Files:**

- Create: `apps/studio/src/components/agent-detail/VersionsSlideOver.tsx`
- Create: `apps/studio/src/components/agent-detail/DslEditorOverlay.tsx`
- Create: `apps/studio/src/components/agent-detail/ChatSlideOver.tsx`
- Modify: `apps/studio/src/components/agent-detail/index.ts`
- Test: `apps/studio/src/__tests__/header-overlays.test.tsx`

**Step 1: Write tests**

Test that each overlay renders when `isOpen` is true and hides when false. Test that VersionsSlideOver wraps existing VersionListTab. Test that DslEditorOverlay wraps existing DslEditorTab as full-viewport. Test that ChatSlideOver wraps existing ChatWithDebugPanel.

**Step 2-5: Implement, verify, commit**

These are thin wrappers that reuse existing tab components:

- `VersionsSlideOver`: Framer Motion slide-from-right panel wrapping `VersionListTab`
- `DslEditorOverlay`: Full-viewport overlay with close button wrapping `DslEditorTab`
- `ChatSlideOver`: Framer Motion slide-from-right panel wrapping `ChatWithDebugPanel`

```bash
git commit -m "[ABLP-2] feat(studio): add slide-over/overlay wrappers for Versions, DSL, Chat"
```

---

## Task 15: Wire Arch panel context to section expansion

When a section expands, update the arch-store editContext. When the [✦] button is clicked, open Arch pre-focused on that section.

**Files:**

- Modify: `apps/studio/src/components/agents/AgentDetailPage.tsx` (add wiring)
- Modify: `apps/studio/src/components/arch/ArchPanel.tsx` (read editContext for contextual chips)
- Test: `apps/studio/src/__tests__/arch-section-wiring.test.tsx`

**Step 1: Write test**

Test that expanding a section calls `setEditContext` with correct section data. Test that clicking [✦] opens arch panel. Test that ArchPanel reads editContext and shows section-specific suggestion chips.

**Step 2-5: Implement, verify, commit**

The wiring:

1. In `AgentDetailPage`, when `expandedSection` changes, call `useArchStore.getState().setEditContext(...)` with the active section's data and sibling context (toolNames, fieldNames, stepNames)
2. When [✦] is clicked, call `openPanel()` + `setEditContext({section, ...})`
3. In `ArchPanel`, read `editContext` and if present, pass `getSuggestionsForSection(editContext.section)` as suggestion chips
4. Include editContext in the Arch chat API context so the LLM knows which section is being edited

```bash
git commit -m "[ABLP-2] feat(studio): wire Arch panel context to section expansion"
```

---

## Task 16: Add Arch chat API context for section-aware editing

Extend the Arch chat API to include `editContext` in requests so the LLM can make section-targeted suggestions.

**Files:**

- Modify: `apps/studio/src/components/arch/ArchPanel.tsx` (include editContext in chat requests)
- Modify: `apps/studio/src/app/api/arch/chat/route.ts` (parse editContext from request context)
- Test: `apps/studio/src/__tests__/arch-section-chat.test.ts`

**Step 1: Write test**

Test that when editContext is present in the request context, the system prompt includes section-specific instructions. Test that the response includes section-relevant suggestions.

**Step 2-5: Implement, verify, commit**

In the chat route:

- Read `context.editContext` from the request
- If present, append to the system prompt: "The user is currently editing the {section} section of agent {agentName}. Current content: {summary}. Other sections: {siblingContext}. Provide suggestions relevant to this section."
- Return section-specific suggestion chips in the response

```bash
git commit -m "[ABLP-2] feat(studio): add section-aware context to Arch chat API"
```

---

## Task 17: Integration test and build verification

Run the full test suite and build to catch any integration issues.

**Files:**

- No new files
- Potentially fix any failing tests in existing files

**Step 1: Run full build**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build
```

Expected: Clean build with no type errors

**Step 2: Run studio tests**

```bash
cd apps/studio && pnpm vitest run
```

Expected: All tests pass

**Step 3: Fix any failures**

Address type errors, import issues, or test failures discovered during integration.

**Step 4: Commit fixes**

```bash
git commit -m "[ABLP-2] fix(studio): resolve integration issues in agent details redesign"
```

---

## Dependency Graph

```
Task 1: agent-detail-store
    ↓
Task 2: arch-store editContext
    ↓
Task 3: SectionCard wrapper
    ↓
Tasks 4-10: Section components (can run in parallel)
├── Task 4: IdentitySection
├── Task 5: ToolsSection
├── Task 6: GatherSection
├── Task 7: FlowSection (+ FlowMiniGraph)
├── Task 8: RulesSection
├── Task 9: CoordinationSection
└── Task 10: LifecycleSection
    ↓
Task 11: useAgentIR hook
Task 12: useSectionEdit hook
    ↓
Task 13: Rewrite AgentDetailPage (main integration)
    ↓
Task 14: Header action overlays
Task 15: Arch panel context wiring
Task 16: Arch chat API context
    ↓
Task 17: Integration test and build verification
```

**Tasks 4-10 are parallelizable** — each section component is independent. All other tasks are sequential.

---

## Reference Files

| File                                                                   | Role                                        |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| `docs/plans/2026-02-20-agent-details-redesign-design.md`               | Design doc (approved)                       |
| `apps/studio/src/store/agent-detail-store.ts`                          | Section state management (Task 1)           |
| `apps/studio/src/store/arch-store.ts`                                  | Arch AI state + editContext (Task 2)        |
| `apps/studio/src/types/arch.ts`                                        | Arch types + ArchEditContext (Task 2)       |
| `apps/studio/src/components/agent-detail/`                             | All new section components (Tasks 3-10, 14) |
| `apps/studio/src/hooks/useAgentIR.ts`                                  | DSL fetch + compile hook (Task 11)          |
| `apps/studio/src/hooks/useSectionEdit.ts`                              | Debounced auto-save hook (Task 12)          |
| `apps/studio/src/components/agents/AgentDetailPage.tsx`                | Main page rewrite (Task 13)                 |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts` | Surgical edit API (existing)                |
| `apps/studio/src/app/api/abl/compile/route.ts`                         | Compile API (existing)                      |
| `apps/studio/src/api/runtime-agents.ts`                                | Agent CRUD client (existing)                |
| `apps/studio/src/hooks/useAgentVersions.ts`                            | Version management hook (existing)          |
| `apps/studio/src/components/arch/ArchPanel.tsx`                        | Arch panel (modify for editContext)         |
| `apps/studio/src/app/api/arch/chat/route.ts`                           | Arch chat API (modify for section context)  |
| `packages/compiler/src/platform/ir/schema.ts`                          | IR type definitions (reference)             |
