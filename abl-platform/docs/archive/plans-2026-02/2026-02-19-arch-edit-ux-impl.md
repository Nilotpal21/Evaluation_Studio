# Arch Edit UX Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the spec generation edit experience so Arch plans before executing, UI stays persistent during cascades, and users get a sequential guided review.

**Architecture:** Extend `ArchMessage` types with `plan`/`proposal`/`system` variants. Add review step tracking and slide-over panel state to `spec-generation-store`. Modify `ReviewScreen` into a persistent layout with slide-over chat. Add `editPhase` to the API route so Arch plans before executing. Replace "Import to Project" with sequential "Looks good" guided review.

**Tech Stack:** React 18, Zustand, TypeScript, Tailwind CSS, Framer Motion, lucide-react, Next.js API routes, Zod

---

### Task 1: Extend Message and Response Types

Add `plan`, `proposal`, and `system` message types plus the `editPhase` context field and response shapes.

**Files:**

- Modify: `apps/studio/src/types/arch.ts:41-60` (ArchMessage type field)
- Modify: `apps/studio/src/types/arch.ts:218-231` (ArchChatResponse additions)
- Modify: `apps/studio/src/types/arch.ts:197-216` (ArchChatRequest context)
- Test: `apps/studio/src/__tests__/arch-edit-ux-types.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/arch-edit-ux-types.test.ts`:

```typescript
/**
 * @vitest-environment happy-dom
 */
import { describe, test, expect } from 'vitest';
import type {
  ArchMessage,
  ArchChatResponse,
  ArchChatRequest,
  PlanChange,
  ProposalData,
  SpecGenStage,
} from '../types/arch';

describe('Arch Edit UX Types', () => {
  test('ArchMessage supports plan type with planData', () => {
    const msg: ArchMessage = {
      id: '1',
      role: 'arch',
      content: 'Here is my plan',
      timestamp: new Date().toISOString(),
      type: 'plan',
      planData: {
        summary: 'Add a billing agent',
        changes: [
          { type: 'add', description: 'New billing agent' },
          { type: 'modify', description: 'Update routing edges' },
        ],
      },
    };
    expect(msg.type).toBe('plan');
    expect(msg.planData?.changes).toHaveLength(2);
  });

  test('ArchMessage supports proposal type with proposalData', () => {
    const msg: ArchMessage = {
      id: '2',
      role: 'arch',
      content: '+1 agent, +2 edges',
      timestamp: new Date().toISOString(),
      type: 'proposal',
      proposalData: {
        stage: 'topology',
        data: { nodes: [], edges: [] },
        summary: '+1 agent, +2 edges',
        changes: [{ type: 'add', description: 'Billing agent node' }],
      },
    };
    expect(msg.type).toBe('proposal');
    expect(msg.proposalData?.stage).toBe('topology');
  });

  test('ArchMessage supports system type', () => {
    const msg: ArchMessage = {
      id: '3',
      role: 'arch',
      content: 'Plan approved. Generating artifacts...',
      timestamp: new Date().toISOString(),
      type: 'system',
    };
    expect(msg.type).toBe('system');
  });

  test('ArchChatResponse supports plan field', () => {
    const res: ArchChatResponse = {
      message: 'Here is my plan',
      type: 'plan',
      plan: {
        summary: 'Add a billing agent',
        changes: [{ type: 'add', description: 'New billing agent' }],
      },
    };
    expect(res.plan?.changes).toHaveLength(1);
  });

  test('ArchChatResponse supports proposal field', () => {
    const res: ArchChatResponse = {
      message: 'Changes ready',
      type: 'proposal',
      proposal: {
        stage: 'agents',
        data: [],
        summary: 'Updated agents',
        changes: [{ type: 'modify', description: 'Updated agent code' }],
      },
    };
    expect(res.proposal?.stage).toBe('agents');
  });

  test('ArchChatRequest context supports editPhase', () => {
    const req: ArchChatRequest = {
      stage: 'edit',
      messages: [{ role: 'user', content: 'Add a billing agent' }],
      context: {
        page: 'spec-generation',
        editingStage: 'topology',
        editPhase: 'planning',
      },
    };
    expect(req.context?.editPhase).toBe('planning');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-edit-ux-types.test.ts`
Expected: FAIL — `PlanChange`, `ProposalData` not exported, `planData`/`proposalData` not on `ArchMessage`, `plan`/`proposal` not on `ArchChatResponse`, `editPhase` not on context.

**Step 3: Add the types to `arch.ts`**

In `apps/studio/src/types/arch.ts`, after the `ArchMessage` interface (around line 60), add:

```typescript
/** A single change entry used in plans and proposals */
export interface PlanChange {
  type: string;
  description: string;
}

/** Data attached to a plan message */
export interface PlanData {
  summary: string;
  changes: PlanChange[];
}

/** Data attached to a proposal message */
export interface ProposalData {
  stage: SpecGenStage;
  data: unknown;
  summary: string;
  changes: PlanChange[];
}
```

Modify `ArchMessage.type` (line 47) from:

```typescript
type?: 'message' | 'error';
```

to:

```typescript
type?: 'message' | 'error' | 'plan' | 'proposal' | 'system';
```

Add to `ArchMessage` interface (after `isStreaming`):

```typescript
/** Structured plan data for type='plan' */
planData?: PlanData;
/** Structured proposal data for type='proposal' */
proposalData?: ProposalData;
```

Modify `ArchChatResponse.type` (line 221) from:

```typescript
type?: 'message' | 'error';
```

to:

```typescript
type?: 'message' | 'error' | 'plan' | 'proposal' | 'system';
```

Add to `ArchChatResponse` (after `mockProject`):

```typescript
/** Plan returned during planning phase */
plan?: PlanData;
/** Proposal returned during execution phase */
proposal?: ProposalData;
```

Add `editPhase` to `ArchChatRequest.context` (after `editingStage` line 208):

```typescript
editPhase?: 'planning' | 'executing';
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-edit-ux-types.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add apps/studio/src/types/arch.ts apps/studio/src/__tests__/arch-edit-ux-types.test.ts
git commit -m "[ABLP-2] feat(studio): extend message types with plan, proposal, system variants"
```

---

### Task 2: Add Review and Edit Panel State to Store

Add `reviewStep`, `reviewedStages`, `editMessages`, `editPanelState`, and `pendingProposal` to the spec-generation store with new actions.

**Files:**

- Modify: `apps/studio/src/store/spec-generation-store.ts`
- Test: `apps/studio/src/__tests__/spec-generation-store.test.ts` (extend)

**Step 1: Write the failing tests**

Append to `apps/studio/src/__tests__/spec-generation-store.test.ts` — add new describe blocks after the existing `reset` section:

```typescript
// ===========================================================================
// 9. REVIEW STEP TRACKING
// ===========================================================================

describe('Review step tracking', () => {
  beforeEach(() => {
    // Complete full pipeline
    const store = useSpecGenerationStore.getState();
    store.startPipeline(SAMPLE_INPUT);
    store.updateStageResult('topology', SAMPLE_TOPOLOGY);
    store.updateStageResult('agents', SAMPLE_AGENTS);
    store.updateStageResult('openapi', SAMPLE_OPENAPI);
    store.updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
  });

  test('pipeline completion sets reviewStep to topology', () => {
    const state = useSpecGenerationStore.getState();
    expect(state.reviewStep).toBe('topology');
    expect(state.reviewedStages).toEqual(new Set());
  });

  test('advanceReview marks current step reviewed and advances', () => {
    useSpecGenerationStore.getState().advanceReview();
    const state = useSpecGenerationStore.getState();
    expect(state.reviewedStages).toContain('topology');
    expect(state.reviewStep).toBe('agents');
  });

  test('advanceReview through all stages ends at null', () => {
    const store = useSpecGenerationStore.getState();
    store.advanceReview(); // topology -> agents
    store.advanceReview(); // agents -> openapi
    store.advanceReview(); // openapi -> mocks
    store.advanceReview(); // mocks -> null (all reviewed)

    const state = useSpecGenerationStore.getState();
    expect(state.reviewStep).toBeNull();
    expect(state.reviewedStages).toEqual(new Set(['topology', 'agents', 'openapi', 'mocks']));
  });

  test('goBackToStage un-reviews from that stage forward', () => {
    const store = useSpecGenerationStore.getState();
    store.advanceReview(); // reviewed: topology
    store.advanceReview(); // reviewed: topology, agents
    store.advanceReview(); // reviewed: topology, agents, openapi

    store.goBackToStage('agents');

    const state = useSpecGenerationStore.getState();
    expect(state.reviewStep).toBe('agents');
    // topology still reviewed, agents/openapi/mocks un-reviewed
    expect(state.reviewedStages).toEqual(new Set(['topology']));
  });
});

// ===========================================================================
// 10. EDIT PANEL STATE
// ===========================================================================

describe('Edit panel state', () => {
  test('initial editPanelState is collapsed', () => {
    const state = useSpecGenerationStore.getState();
    expect(state.editPanelState).toBe('collapsed');
  });

  test('setEditPanelState updates the state', () => {
    useSpecGenerationStore.getState().setEditPanelState('expanded');
    expect(useSpecGenerationStore.getState().editPanelState).toBe('expanded');

    useSpecGenerationStore.getState().setEditPanelState('minimized');
    expect(useSpecGenerationStore.getState().editPanelState).toBe('minimized');
  });
});

// ===========================================================================
// 11. EDIT MESSAGES PER STAGE
// ===========================================================================

describe('Edit messages per stage', () => {
  test('initial editMessages is empty for all stages', () => {
    const state = useSpecGenerationStore.getState();
    expect(state.editMessages.topology).toEqual([]);
    expect(state.editMessages.agents).toEqual([]);
    expect(state.editMessages.openapi).toEqual([]);
    expect(state.editMessages.mocks).toEqual([]);
  });

  test('addEditMessage appends to correct stage thread', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Add billing agent',
      timestamp: new Date().toISOString(),
    };
    useSpecGenerationStore.getState().addEditMessage('topology', msg);

    const state = useSpecGenerationStore.getState();
    expect(state.editMessages.topology).toHaveLength(1);
    expect(state.editMessages.topology[0].content).toBe('Add billing agent');
    // Other stages unaffected
    expect(state.editMessages.agents).toEqual([]);
  });
});

// ===========================================================================
// 12. PENDING PROPOSAL
// ===========================================================================

describe('Pending proposal', () => {
  beforeEach(() => {
    const store = useSpecGenerationStore.getState();
    store.startPipeline(SAMPLE_INPUT);
    store.updateStageResult('topology', SAMPLE_TOPOLOGY);
    store.updateStageResult('agents', SAMPLE_AGENTS);
    store.updateStageResult('openapi', SAMPLE_OPENAPI);
    store.updateStageResult('mocks', SAMPLE_MOCK_PROJECT);
  });

  test('setPendingProposal stores proposal', () => {
    useSpecGenerationStore.getState().setPendingProposal({
      stage: 'topology',
      data: { nodes: [], edges: [] },
      summary: '+1 agent',
      changes: [{ type: 'add', description: 'Billing agent' }],
    });

    const state = useSpecGenerationStore.getState();
    expect(state.pendingProposal).not.toBeNull();
    expect(state.pendingProposal?.stage).toBe('topology');
  });

  test('applyProposal commits data and triggers cascade', () => {
    useSpecGenerationStore.getState().setPendingProposal({
      stage: 'topology',
      data: SAMPLE_TOPOLOGY,
      summary: 'Updated topology',
      changes: [],
    });

    useSpecGenerationStore.getState().applyProposal();

    const state = useSpecGenerationStore.getState();
    expect(state.pendingProposal).toBeNull();
    expect(state.stageResults.topology).toEqual(SAMPLE_TOPOLOGY);
    // Downstream cleared (cascade triggered)
    expect(state.stageResults.agents).toBeNull();
    expect(state.pipelineStatus).toBe('running');
  });

  test('rejectProposal clears proposal but keeps chat open', () => {
    useSpecGenerationStore.getState().setPendingProposal({
      stage: 'agents',
      data: SAMPLE_AGENTS,
      summary: 'Updated agents',
      changes: [],
    });

    useSpecGenerationStore.getState().rejectProposal();

    const state = useSpecGenerationStore.getState();
    expect(state.pendingProposal).toBeNull();
    // editPanelState not changed (chat stays open)
  });

  test('applyProposal on last stage does not cascade', () => {
    useSpecGenerationStore.getState().setPendingProposal({
      stage: 'mocks',
      data: SAMPLE_MOCK_PROJECT,
      summary: 'Updated mocks',
      changes: [],
    });

    useSpecGenerationStore.getState().applyProposal();

    const state = useSpecGenerationStore.getState();
    expect(state.pendingProposal).toBeNull();
    expect(state.stageResults.mockProject).toEqual(SAMPLE_MOCK_PROJECT);
    expect(state.pipelineStatus).toBe('complete');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/studio && pnpm vitest run src/__tests__/spec-generation-store.test.ts`
Expected: FAIL — new fields and actions don't exist.

**Step 3: Implement store changes**

Modify `apps/studio/src/store/spec-generation-store.ts`:

Import `ArchMessage` type at top:

```typescript
import type {
  SpecGenInput,
  SpecGenStage,
  SpecGenStageResults,
  EditHistoryEntry,
  VercelDeployResult,
  TopologyData,
  GeneratedAgent,
  OpenAPISpec,
  MockProjectBundle,
  ArchMessage as ArchMessageType,
  PlanChange,
} from '../types/arch';
```

Extend `SpecGenerationState` interface with new fields:

```typescript
reviewStep: SpecGenStage | null;
reviewedStages: Set<SpecGenStage>;
editMessages: Record<SpecGenStage, ArchMessageType[]>;
editPanelState: 'collapsed' | 'default' | 'expanded' | 'minimized';
pendingProposal: {
  stage: SpecGenStage;
  data: unknown;
  summary: string;
  changes: PlanChange[];
} | null;
```

Add new actions to the interface:

```typescript
advanceReview: () => void;
goBackToStage: (stage: SpecGenStage) => void;
setEditPanelState: (state: 'collapsed' | 'default' | 'expanded' | 'minimized') => void;
addEditMessage: (stage: SpecGenStage, message: ArchMessageType) => void;
setPendingProposal: (proposal: { stage: SpecGenStage; data: unknown; summary: string; changes: PlanChange[] }) => void;
applyProposal: () => void;
rejectProposal: () => void;
```

Extend `INITIAL_STATE`:

```typescript
reviewStep: null as SpecGenStage | null,
reviewedStages: new Set<SpecGenStage>(),
editMessages: {
  topology: [],
  agents: [],
  openapi: [],
  mocks: [],
} as Record<SpecGenStage, ArchMessageType[]>,
editPanelState: 'collapsed' as const,
pendingProposal: null as { stage: SpecGenStage; data: unknown; summary: string; changes: PlanChange[] } | null,
```

Modify `updateStageResult` — when pipeline completes (last stage), also set `reviewStep: 'topology'`:

```typescript
if (isLastStage(stage)) {
  return {
    stageResults: updatedResults,
    pipelineStatus: 'complete' as const,
    reviewStep: 'topology',
    reviewedStages: new Set<SpecGenStage>(),
  };
}
```

Add cascade auto-minimize: In `commitEdit`, when cascade starts (not last stage), set `editPanelState: 'minimized'` and clear `reviewedStages` from the edited stage forward:

In the non-last-stage branch of `commitEdit`:

```typescript
const clearedResults = clearDownstreamResults(updatedResults, stage);
const idx = stageIndex(stage);
const clearedReviewed = new Set([...state.reviewedStages].filter((s) => stageIndex(s) < idx));
return {
  stageResults: clearedResults,
  editingStage: null,
  editHistory: [...state.editHistory, entry],
  pipelineStatus: 'running' as const,
  currentStage: nextStage(stage),
  editPanelState: 'minimized' as const,
  reviewedStages: clearedReviewed,
  reviewStep: stage,
};
```

Implement new actions:

```typescript
advanceReview: () =>
  set((state) => {
    if (!state.reviewStep) return {};
    const reviewed = new Set(state.reviewedStages);
    reviewed.add(state.reviewStep);
    const next = nextStage(state.reviewStep);
    return {
      reviewedStages: reviewed,
      reviewStep: next,
    };
  }),

goBackToStage: (stage) =>
  set((state) => {
    const idx = stageIndex(stage);
    const reviewed = new Set(
      [...state.reviewedStages].filter(s => stageIndex(s) < idx)
    );
    return {
      reviewStep: stage,
      reviewedStages: reviewed,
    };
  }),

setEditPanelState: (panelState) => set({ editPanelState: panelState }),

addEditMessage: (stage, message) =>
  set((state) => ({
    editMessages: {
      ...state.editMessages,
      [stage]: [...state.editMessages[stage], message],
    },
  })),

setPendingProposal: (proposal) => set({ pendingProposal: proposal }),

applyProposal: () =>
  set((state) => {
    if (!state.pendingProposal) return {};
    const { stage, data } = state.pendingProposal;
    const key = STAGE_RESULT_KEY[stage];
    const updatedResults = {
      ...state.stageResults,
      [key]: data,
    };

    const entry: EditHistoryEntry = {
      stage,
      timestamp: new Date().toISOString(),
      summary: state.pendingProposal.summary,
    };

    if (isLastStage(stage)) {
      return {
        stageResults: updatedResults,
        pendingProposal: null,
        editHistory: [...state.editHistory, entry],
        pipelineStatus: 'complete' as const,
      };
    }

    const clearedResults = clearDownstreamResults(updatedResults, stage);
    const idx = stageIndex(stage);
    const clearedReviewed = new Set(
      [...state.reviewedStages].filter(s => stageIndex(s) < idx)
    );
    return {
      stageResults: clearedResults,
      pendingProposal: null,
      editHistory: [...state.editHistory, entry],
      pipelineStatus: 'running' as const,
      currentStage: nextStage(stage),
      editPanelState: 'minimized' as const,
      reviewedStages: clearedReviewed,
      reviewStep: stage,
    };
  }),

rejectProposal: () => set({ pendingProposal: null }),
```

Also update `reset` to clear new fields:

```typescript
reset: () =>
  set({
    ...INITIAL_STATE,
    stageResults: { ...INITIAL_STAGE_RESULTS },
    stageErrors: {},
    editHistory: [],
    reviewStep: null,
    reviewedStages: new Set<SpecGenStage>(),
    editMessages: { topology: [], agents: [], openapi: [], mocks: [] },
    editPanelState: 'collapsed',
    pendingProposal: null,
  }),
```

**Step 4: Run tests**

Run: `cd apps/studio && pnpm vitest run src/__tests__/spec-generation-store.test.ts`
Expected: PASS (all existing + new tests)

**Step 5: Commit**

```bash
git add apps/studio/src/store/spec-generation-store.ts apps/studio/src/__tests__/spec-generation-store.test.ts
git commit -m "[ABLP-2] feat(studio): add review tracking, edit panel state, and proposal actions to spec store"
```

---

### Task 3: Add `editPhase` to API Route

Update the chat API route to support planning vs executing phases. When `editPhase === 'planning'`, Arch returns a plan (no artifacts). When `editPhase === 'executing'`, Arch generates artifacts and returns a proposal.

**Files:**

- Modify: `apps/studio/src/app/api/arch/chat/route.ts:194-224` (request schema)
- Modify: `apps/studio/src/app/api/arch/chat/route.ts:504-660` (system prompt)
- Modify: `apps/studio/src/app/api/arch/chat/route.ts:283-316` (response handling)

**Step 1: Update the request schema**

In `route.ts`, add `editPhase` to the `chatRequestSchema` context object (around line 213):

```typescript
editPhase: z.enum(['planning', 'executing']).optional(),
```

**Step 2: Update the system prompt for edit stage**

Replace the `edit` entry in `stagePrompts` (around line 592-607) with two variants based on `editPhase`. Modify `buildSystemPrompt` to accept `editPhase` in the context type and use it:

When `editPhase === 'planning'`:

```
You are reviewing a previously generated agent specification. The user wants to make changes.

Your job RIGHT NOW is to create a PLAN — do NOT generate any artifacts yet.

1. Analyze the user's request against the current spec
2. Respond with a structured plan as a JSON code block:
\`\`\`json
{
  "summary": "Brief description of what will change",
  "changes": [
    { "type": "add|modify|remove", "description": "What specifically changes" }
  ]
}
\`\`\`
3. After the JSON, add a brief conversational explanation of the plan

Do NOT include any artifact JSON (topology, agents, openapi, mocks). Only the plan.
```

When `editPhase === 'executing'`:

```
The user has approved your plan. Now generate the complete updated artifact.

IMPORTANT: Include the COMPLETE updated artifact as a JSON code block.
For topology: \`\`\`json { "nodes": [...], "edges": [...] } \`\`\`
For agents: \`\`\`json [...] \`\`\`
For openapi: \`\`\`json { "openapi": "3.1.0", ... } \`\`\`
For mocks: \`\`\`json { "projectName": "...", "files": [...] } \`\`\`
Always output the COMPLETE updated artifact, not just changed parts.
Also include a brief summary of what was changed.
```

**Step 3: Update response handling for plan vs proposal**

In the simple chat response section (around lines 291-304), modify the edit response handling:

```typescript
if (stage === 'edit' && context?.editingStage) {
  // Planning phase — extract plan
  if (context.editPhase === 'planning') {
    const parsedJson = parseJsonFromResponse(responseText);
    if (parsedJson && typeof parsedJson === 'object' && 'summary' in (parsedJson as any)) {
      const planData = parsedJson as {
        summary: string;
        changes: { type: string; description: string }[];
      };
      return NextResponse.json({
        success: true,
        data: {
          message: stripJsonBlock(responseText),
          type: 'plan',
          plan: planData,
          suggestions: [],
        },
      });
    }
    // No structured plan found — return as normal message
    return NextResponse.json({
      success: true,
      data: {
        message: responseText,
        type: 'message',
        suggestions: [],
      },
    });
  }

  // Executing phase — extract artifact as proposal
  if (context.editPhase === 'executing') {
    const parsedJson = parseJsonFromResponse(responseText);
    const artifactData = extractEditArtifact(context.editingStage, parsedJson);
    const hasArtifact = Object.keys(artifactData).length > 0;

    if (hasArtifact) {
      const artifactKey = Object.keys(artifactData)[0];
      return NextResponse.json({
        success: true,
        data: {
          message: stripJsonBlock(responseText),
          type: 'proposal',
          proposal: {
            stage: context.editingStage,
            data: artifactData[artifactKey as keyof typeof artifactData],
            summary: stripJsonBlock(responseText).slice(0, 200),
            changes: [],
          },
          suggestions: [],
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        message: responseText,
        type: 'message',
        suggestions: [],
      },
    });
  }

  // Legacy: no editPhase specified — use old behavior
  const parsedJson = parseJsonFromResponse(responseText);
  const artifactData = extractEditArtifact(context.editingStage, parsedJson);
  const hasArtifact = Object.keys(artifactData).length > 0;

  return NextResponse.json({
    success: true,
    data: {
      message: hasArtifact ? stripJsonBlock(responseText) : responseText,
      suggestions: [],
      ...artifactData,
    },
  });
}
```

**Step 4: Build and verify**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds.

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-edit-ux-types.test.ts src/__tests__/spec-generation-store.test.ts`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add apps/studio/src/app/api/arch/chat/route.ts
git commit -m "[ABLP-2] feat(studio): add editPhase support to chat API route for plan-then-execute flow"
```

---

### Task 4: Plan and Proposal Chat Message Rendering

Create new message components for `plan`, `proposal`, and `system` message types. Extend `ArchChat` to render them.

**Files:**

- Create: `apps/studio/src/components/arch/PlanMessage.tsx`
- Create: `apps/studio/src/components/arch/ProposalMessage.tsx`
- Modify: `apps/studio/src/components/arch/ArchChat.tsx:110-142` (message rendering)
- Test: `apps/studio/src/__tests__/plan-proposal-messages.test.tsx`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/plan-proposal-messages.test.tsx`:

```typescript
/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ArchMessage } from '../types/arch';

// Mock arch-store
vi.mock('../store/arch-store', () => ({
  useArchStore: () => ({
    conversations: {},
    activeConversationId: 'new',
    isTyping: false,
    suggestions: [],
  }),
}));

// Import after mocks
import { ArchChat } from '../components/arch/ArchChat';

describe('Plan message rendering', () => {
  test('renders plan message with Go ahead and Refine buttons', () => {
    const planMsg: ArchMessage = {
      id: 'plan-1',
      role: 'arch',
      content: 'Here is my plan to add a billing agent.',
      timestamp: new Date().toISOString(),
      type: 'plan',
      planData: {
        summary: 'Add billing agent and routing edge',
        changes: [
          { type: 'add', description: 'New billing agent node' },
          { type: 'add', description: 'Routing edge from supervisor' },
        ],
      },
    };

    render(
      <ArchChat
        messages={[planMsg]}
        onSendMessage={vi.fn()}
        onPlanAction={vi.fn()}
      />,
    );

    expect(screen.getByText('Add billing agent and routing edge')).toBeInTheDocument();
    expect(screen.getByText('New billing agent node')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go ahead/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refine/i })).toBeInTheDocument();
  });

  test('Go ahead button calls onPlanAction with approve', () => {
    const onPlanAction = vi.fn();
    const planMsg: ArchMessage = {
      id: 'plan-1',
      role: 'arch',
      content: 'Plan summary',
      timestamp: new Date().toISOString(),
      type: 'plan',
      planData: {
        summary: 'Add billing agent',
        changes: [{ type: 'add', description: 'Billing agent' }],
      },
    };

    render(
      <ArchChat
        messages={[planMsg]}
        onSendMessage={vi.fn()}
        onPlanAction={onPlanAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /go ahead/i }));
    expect(onPlanAction).toHaveBeenCalledWith('approve');
  });
});

describe('Proposal message rendering', () => {
  test('renders proposal with Apply and Reject buttons', () => {
    const proposalMsg: ArchMessage = {
      id: 'prop-1',
      role: 'arch',
      content: 'Changes are ready.',
      timestamp: new Date().toISOString(),
      type: 'proposal',
      proposalData: {
        stage: 'topology',
        data: { nodes: [], edges: [] },
        summary: '+1 agent, +1 edge',
        changes: [{ type: 'add', description: 'Billing agent' }],
      },
    };

    render(
      <ArchChat
        messages={[proposalMsg]}
        onSendMessage={vi.fn()}
        onProposalAction={vi.fn()}
      />,
    );

    expect(screen.getByText('+1 agent, +1 edge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  test('Apply button calls onProposalAction with apply', () => {
    const onProposalAction = vi.fn();
    const proposalMsg: ArchMessage = {
      id: 'prop-1',
      role: 'arch',
      content: 'Done.',
      timestamp: new Date().toISOString(),
      type: 'proposal',
      proposalData: {
        stage: 'topology',
        data: {},
        summary: 'Updated',
        changes: [],
      },
    };

    render(
      <ArchChat
        messages={[proposalMsg]}
        onSendMessage={vi.fn()}
        onProposalAction={onProposalAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onProposalAction).toHaveBeenCalledWith('apply');
  });
});

describe('System message rendering', () => {
  test('renders system message as centered muted text without bubble', () => {
    const sysMsg: ArchMessage = {
      id: 'sys-1',
      role: 'arch',
      content: 'Plan approved. Generating artifacts...',
      timestamp: new Date().toISOString(),
      type: 'system',
    };

    render(
      <ArchChat
        messages={[sysMsg]}
        onSendMessage={vi.fn()}
      />,
    );

    const el = screen.getByText('Plan approved. Generating artifacts...');
    expect(el).toBeInTheDocument();
    // System messages should have text-center and muted styling
    expect(el.closest('div')).toHaveClass('text-center');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/plan-proposal-messages.test.tsx`
Expected: FAIL — components don't render plan/proposal/system variants.

**Step 3: Create PlanMessage component**

Create `apps/studio/src/components/arch/PlanMessage.tsx`:

```tsx
import { Check, Pencil } from 'lucide-react';
import { ArchIcon } from './ArchIcon';
import type { PlanData } from '../../types/arch';

interface PlanMessageProps {
  content: string;
  planData: PlanData;
  onApprove: () => void;
  onRefine: () => void;
}

export function PlanMessage({ content, planData, onApprove, onRefine }: PlanMessageProps) {
  return (
    <div className="flex gap-3 message-appear justify-start">
      <div className="w-7 h-7 rounded-lg bg-purple-subtle flex items-center justify-center shrink-0 mt-0.5">
        <ArchIcon size={16} />
      </div>
      <div className="max-w-[85%] min-w-0">
        <span className="text-xs font-medium text-muted mb-1 block">Arch</span>
        <div className="bg-background-subtle border border-default rounded-2xl rounded-tl-md overflow-hidden">
          {/* Conversational text */}
          {content && (
            <div className="px-4 pt-3 pb-2 text-sm text-foreground leading-relaxed">{content}</div>
          )}
          {/* Structured plan card */}
          <div className="px-4 py-3 border-t border-default bg-background-muted/50">
            <p className="text-sm font-medium text-foreground mb-2">{planData.summary}</p>
            <ul className="space-y-1">
              {planData.changes.map((change, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted">
                  <span className="text-accent mt-0.5 shrink-0">
                    {change.type === 'add' ? '+' : change.type === 'remove' ? '−' : '~'}
                  </span>
                  <span>{change.description}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-default">
            <button
              onClick={onApprove}
              aria-label="Go ahead"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default btn-press cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Go ahead
            </button>
            <button
              onClick={onRefine}
              aria-label="Refine"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5" />
              Refine...
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 4: Create ProposalMessage component**

Create `apps/studio/src/components/arch/ProposalMessage.tsx`:

```tsx
import { Check, X } from 'lucide-react';
import { ArchIcon } from './ArchIcon';
import type { ProposalData } from '../../types/arch';

interface ProposalMessageProps {
  content: string;
  proposalData: ProposalData;
  onApply: () => void;
  onReject: () => void;
}

export function ProposalMessage({
  content,
  proposalData,
  onApply,
  onReject,
}: ProposalMessageProps) {
  return (
    <div className="flex gap-3 message-appear justify-start">
      <div className="w-7 h-7 rounded-lg bg-purple-subtle flex items-center justify-center shrink-0 mt-0.5">
        <ArchIcon size={16} />
      </div>
      <div className="max-w-[85%] min-w-0">
        <span className="text-xs font-medium text-muted mb-1 block">Arch</span>
        <div className="bg-success/5 border border-success/20 rounded-2xl rounded-tl-md overflow-hidden">
          {/* Summary text */}
          {content && (
            <div className="px-4 pt-3 pb-2 text-sm text-foreground leading-relaxed">{content}</div>
          )}
          {/* Change summary card */}
          <div className="px-4 py-3 border-t border-success/10 bg-success/5">
            <p className="text-sm font-medium text-success mb-1">{proposalData.summary}</p>
            {proposalData.changes.length > 0 && (
              <ul className="space-y-0.5">
                {proposalData.changes.map((change, i) => (
                  <li key={i} className="text-xs text-muted">
                    {change.type === 'add' ? '+' : change.type === 'remove' ? '−' : '~'}{' '}
                    {change.description}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-success/10">
            <button
              onClick={onApply}
              aria-label="Apply"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-success text-white rounded-lg hover:opacity-90 transition-default btn-press cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Apply
            </button>
            <button
              onClick={onReject}
              aria-label="Reject"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Reject
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 5: Update ArchChat to render new message types**

Modify `apps/studio/src/components/arch/ArchChat.tsx`:

Add imports:

```typescript
import { PlanMessage } from './PlanMessage';
import { ProposalMessage } from './ProposalMessage';
```

Add new props to `ArchChatProps`:

```typescript
/** Callback when user acts on a plan (approve or refine) */
onPlanAction?: (action: 'approve' | 'refine') => void;
/** Callback when user acts on a proposal (apply or reject) */
onProposalAction?: (action: 'apply' | 'reject') => void;
```

Destructure in component:

```typescript
onPlanAction,
onProposalAction,
```

Replace the message rendering loop (lines 120-137) with:

```tsx
{
  messages.map((msg) => {
    if (msg.type === 'system') {
      return (
        <div key={msg.id} className="text-center my-2">
          <span className="text-xs text-subtle">{msg.content}</span>
        </div>
      );
    }
    if (msg.type === 'plan' && msg.planData && onPlanAction) {
      return (
        <PlanMessage
          key={msg.id}
          content={msg.content}
          planData={msg.planData}
          onApprove={() => onPlanAction('approve')}
          onRefine={() => onPlanAction('refine')}
        />
      );
    }
    if (msg.type === 'proposal' && msg.proposalData && onProposalAction) {
      return (
        <ProposalMessage
          key={msg.id}
          content={msg.content}
          proposalData={msg.proposalData}
          onApply={() => onProposalAction('apply')}
          onReject={() => onProposalAction('reject')}
        />
      );
    }
    if (msg.type === 'error') {
      return (
        <div
          key={msg.id}
          className="mx-0 my-2 px-3 py-2 bg-error/10 border border-error/20 rounded-lg text-sm text-error flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{msg.content}</span>
        </div>
      );
    }
    return (
      <ArchMessage
        key={msg.id}
        message={msg}
        onApplyDiff={onApplyDiff}
        onRejectDiff={onRejectDiff}
      />
    );
  });
}
```

**Step 6: Export new components from arch index**

Add to `apps/studio/src/components/arch/index.ts`:

```typescript
export { PlanMessage } from './PlanMessage';
export { ProposalMessage } from './ProposalMessage';
```

**Step 7: Run tests**

Run: `cd apps/studio && pnpm vitest run src/__tests__/plan-proposal-messages.test.tsx src/__tests__/arch-components.test.tsx`
Expected: All pass.

**Step 8: Commit**

```bash
git add apps/studio/src/components/arch/PlanMessage.tsx apps/studio/src/components/arch/ProposalMessage.tsx apps/studio/src/components/arch/ArchChat.tsx apps/studio/src/components/arch/index.ts apps/studio/src/__tests__/plan-proposal-messages.test.tsx
git commit -m "[ABLP-2] feat(studio): add plan, proposal, and system message rendering in ArchChat"
```

---

### Task 5: Slide-Over Edit Chat Panel

Create the `EditSlideOver` component that wraps `ArchChat` in a slide-over panel with collapsed/default/expanded/minimized states. This replaces the fixed 340px edit panel in ReviewScreen.

**Files:**

- Create: `apps/studio/src/components/spec-generation/EditSlideOver.tsx`
- Test: `apps/studio/src/__tests__/edit-slide-over.test.tsx`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/edit-slide-over.test.tsx`:

```typescript
/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock the stores
const mockSpecGenStore: Record<string, any> = {
  editPanelState: 'collapsed',
  editingStage: null,
  editMessages: { topology: [], agents: [], openapi: [], mocks: [] },
  pendingProposal: null,
  setEditPanelState: vi.fn(),
  startEditing: vi.fn(),
  stopEditing: vi.fn(),
  addEditMessage: vi.fn(),
  setPendingProposal: vi.fn(),
  applyProposal: vi.fn(),
  rejectProposal: vi.fn(),
  stageResults: {
    topology: { nodes: [], edges: [] },
    agents: [],
    openapi: null,
    mockProject: null,
  },
};

vi.mock('../../store/spec-generation-store', () => ({
  useSpecGenerationStore: (selector?: any) =>
    selector ? selector(mockSpecGenStore) : mockSpecGenStore,
}));

vi.mock('../../store/arch-store', () => ({
  useArchStore: () => ({
    conversations: {},
    activeConversationId: 'new',
    isTyping: false,
    suggestions: [],
  }),
}));

vi.mock('../../api/arch', () => ({
  sendArchChat: vi.fn().mockResolvedValue({ message: 'OK', type: 'message' }),
}));

import { EditSlideOver } from '../components/spec-generation/EditSlideOver';

describe('EditSlideOver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecGenStore.editPanelState = 'collapsed';
    mockSpecGenStore.editingStage = null;
  });

  test('renders collapsed state with Edit with Arch button', () => {
    render(<EditSlideOver activeTab="topology" />);
    expect(screen.getByRole('button', { name: /edit with arch/i })).toBeInTheDocument();
  });

  test('renders minimized state with Arch icon strip', () => {
    mockSpecGenStore.editPanelState = 'minimized';
    mockSpecGenStore.editingStage = 'topology';
    render(<EditSlideOver activeTab="topology" />);
    // Should show the minimized strip — clicking it opens default
    const strip = screen.getByTestId('edit-panel-minimized');
    expect(strip).toBeInTheDocument();
  });

  test('renders default state with chat panel', () => {
    mockSpecGenStore.editPanelState = 'default';
    mockSpecGenStore.editingStage = 'topology';
    render(<EditSlideOver activeTab="topology" />);
    expect(screen.getByPlaceholderText(/describe changes/i)).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/edit-slide-over.test.tsx`
Expected: FAIL — module not found.

**Step 3: Create EditSlideOver component**

Create `apps/studio/src/components/spec-generation/EditSlideOver.tsx`:

```tsx
/**
 * EditSlideOver
 *
 * Slide-over panel for Arch edit chat during spec review.
 * Four states: collapsed, default (~380px), expanded (~50%), minimized (~48px strip).
 */

import { useState, useCallback } from 'react';
import { Sparkles, X, Maximize2, Minimize2, MessageSquare } from 'lucide-react';
import { clsx } from 'clsx';
import { ArchChat } from '../arch/ArchChat';
import { ArchIcon } from '../arch/ArchIcon';
import { useSpecGenerationStore } from '../../store/spec-generation-store';
import { sendArchChat } from '../../api/arch';
import type { SpecGenStage, ArchMessage as ArchMessageType } from '../../types/arch';

interface EditSlideOverProps {
  activeTab: SpecGenStage;
}

const PANEL_WIDTHS = {
  collapsed: 'w-0',
  default: 'w-[380px]',
  expanded: 'w-[50%]',
  minimized: 'w-12',
} as const;

export function EditSlideOver({ activeTab }: EditSlideOverProps) {
  const editPanelState = useSpecGenerationStore((s) => s.editPanelState);
  const editingStage = useSpecGenerationStore((s) => s.editingStage);
  const editMessages = useSpecGenerationStore((s) => s.editMessages);
  const pendingProposal = useSpecGenerationStore((s) => s.pendingProposal);
  const stageResults = useSpecGenerationStore((s) => s.stageResults);
  const setEditPanelState = useSpecGenerationStore((s) => s.setEditPanelState);
  const startEditing = useSpecGenerationStore((s) => s.startEditing);
  const stopEditing = useSpecGenerationStore((s) => s.stopEditing);
  const addEditMessage = useSpecGenerationStore((s) => s.addEditMessage);
  const setPendingProposal = useSpecGenerationStore((s) => s.setPendingProposal);
  const applyProposal = useSpecGenerationStore((s) => s.applyProposal);
  const rejectProposal = useSpecGenerationStore((s) => s.rejectProposal);

  const [isTyping, setIsTyping] = useState(false);
  const [editPhase, setEditPhase] = useState<'planning' | 'executing'>('planning');

  const currentMessages = editingStage ? editMessages[editingStage] : [];

  const handleOpen = useCallback(() => {
    startEditing(activeTab);
    setEditPanelState('default');
    setEditPhase('planning');

    // Add welcome message if no messages for this stage
    if (editMessages[activeTab].length === 0) {
      const stageLabels: Record<SpecGenStage, string> = {
        topology: 'topology',
        agents: 'agents',
        openapi: 'API spec',
        mocks: 'mock data',
      };
      const welcome: ArchMessageType = {
        id: `welcome-${activeTab}-${Date.now()}`,
        role: 'arch',
        content: `I'm ready to help you refine the **${stageLabels[activeTab]}**. Describe what you'd like to change and I'll create a plan first.`,
        timestamp: new Date().toISOString(),
        agentName: 'Arch',
      };
      addEditMessage(activeTab, welcome);
    }
  }, [activeTab, editMessages, startEditing, setEditPanelState, addEditMessage]);

  const handleClose = useCallback(() => {
    stopEditing();
    setEditPanelState('collapsed');
  }, [stopEditing, setEditPanelState]);

  const handleMinimize = useCallback(() => {
    setEditPanelState('minimized');
  }, [setEditPanelState]);

  const handleExpand = useCallback(() => {
    setEditPanelState(editPanelState === 'expanded' ? 'default' : 'expanded');
  }, [editPanelState, setEditPanelState]);

  const handleRestore = useCallback(() => {
    setEditPanelState('default');
  }, [setEditPanelState]);

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!editingStage) return;

      const userMsg: ArchMessageType = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };
      addEditMessage(editingStage, userMsg);
      setIsTyping(true);

      try {
        const specContext: Record<string, string> = {};
        if (stageResults.topology) specContext.topology = JSON.stringify(stageResults.topology);
        if (editingStage === 'agents' && stageResults.agents)
          specContext.agents = JSON.stringify(stageResults.agents);
        if (editingStage === 'openapi' && stageResults.openapi)
          specContext.openapi = JSON.stringify(stageResults.openapi);
        if (editingStage === 'mocks' && stageResults.mockProject)
          specContext.mockProject = JSON.stringify(stageResults.mockProject);

        const allMessages = [...editMessages[editingStage], userMsg];
        const response = await sendArchChat({
          stage: 'edit',
          messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
          context: {
            page: 'spec-generation',
            editingStage,
            editPhase,
            generatedSpec: specContext,
          },
        });

        const archMsg: ArchMessageType = {
          id: `arch-${Date.now()}`,
          role: 'arch',
          content: response.message,
          type: response.type,
          timestamp: new Date().toISOString(),
          agentName: 'Arch',
          planData: response.plan,
          proposalData: response.proposal,
        };
        addEditMessage(editingStage, archMsg);

        // If proposal received, store it
        if (response.proposal) {
          setPendingProposal(response.proposal);
        }
      } catch (err) {
        console.error('[EditSlideOver] Chat failed:', err);
        const errorMsg: ArchMessageType = {
          id: `error-${Date.now()}`,
          role: 'arch',
          content: 'Sorry, I encountered an error. Please try again.',
          type: 'error',
          timestamp: new Date().toISOString(),
          agentName: 'Arch',
        };
        addEditMessage(editingStage, errorMsg);
      } finally {
        setIsTyping(false);
      }
    },
    [editingStage, editMessages, stageResults, editPhase, addEditMessage, setPendingProposal],
  );

  const handlePlanAction = useCallback(
    (action: 'approve' | 'refine') => {
      if (!editingStage) return;
      if (action === 'approve') {
        setEditPhase('executing');
        const sysMsg: ArchMessageType = {
          id: `sys-${Date.now()}`,
          role: 'arch',
          content: 'Plan approved. Generating artifacts...',
          timestamp: new Date().toISOString(),
          type: 'system',
        };
        addEditMessage(editingStage, sysMsg);
        // Auto-send execution request
        handleSendMessage('Go ahead with the plan.');
      }
      // 'refine' — user types a new message naturally, no action needed
    },
    [editingStage, addEditMessage, handleSendMessage],
  );

  const handleProposalAction = useCallback(
    (action: 'apply' | 'reject') => {
      if (!editingStage) return;
      if (action === 'apply') {
        applyProposal();
        const sysMsg: ArchMessageType = {
          id: `sys-${Date.now()}`,
          role: 'arch',
          content: 'Changes applied.',
          timestamp: new Date().toISOString(),
          type: 'system',
        };
        addEditMessage(editingStage, sysMsg);
        setEditPhase('planning');
      } else {
        rejectProposal();
        const sysMsg: ArchMessageType = {
          id: `sys-${Date.now()}`,
          role: 'arch',
          content: 'Proposal rejected. You can refine your request or try something different.',
          timestamp: new Date().toISOString(),
          type: 'system',
        };
        addEditMessage(editingStage, sysMsg);
        setEditPhase('planning');
      }
    },
    [editingStage, applyProposal, rejectProposal, addEditMessage],
  );

  // --- COLLAPSED: just the button ---
  if (editPanelState === 'collapsed') {
    return (
      <button
        onClick={handleOpen}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-purple bg-purple/10 border border-purple/20 rounded-lg hover:bg-purple/20 transition-default cursor-pointer"
      >
        <Sparkles className="w-4 h-4" />
        Edit with Arch
      </button>
    );
  }

  // --- MINIMIZED: thin strip ---
  if (editPanelState === 'minimized') {
    return (
      <div
        data-testid="edit-panel-minimized"
        className="w-12 shrink-0 border-l border-default bg-background-subtle flex flex-col items-center py-3 cursor-pointer hover:bg-background-muted transition-default"
        onClick={handleRestore}
      >
        <ArchIcon size={20} />
        {currentMessages.length > 0 && <div className="w-2 h-2 rounded-full bg-accent mt-2" />}
      </div>
    );
  }

  // --- DEFAULT / EXPANDED ---
  return (
    <div
      className={clsx(
        'shrink-0 flex flex-col border-l border-default bg-background transition-all duration-300',
        editPanelState === 'expanded' ? 'w-[50%]' : 'w-[380px]',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-default bg-background-subtle">
        <div className="flex items-center gap-2">
          <ArchIcon size={16} />
          <span className="text-sm font-medium text-foreground">Arch</span>
          {editingStage && <span className="text-xs text-muted">· {editingStage}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleExpand}
            className="p-1 text-muted hover:text-foreground rounded transition-default cursor-pointer"
            title={editPanelState === 'expanded' ? 'Shrink' : 'Expand'}
          >
            {editPanelState === 'expanded' ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={handleMinimize}
            className="p-1 text-muted hover:text-foreground rounded transition-default cursor-pointer"
            title="Minimize"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleClose}
            className="p-1 text-muted hover:text-foreground rounded transition-default cursor-pointer"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Chat */}
      <ArchChat
        messages={currentMessages}
        isTyping={isTyping}
        onSendMessage={handleSendMessage}
        onPlanAction={handlePlanAction}
        onProposalAction={handleProposalAction}
        placeholder={`Describe changes to ${editingStage ?? activeTab}...`}
        className="flex-1"
      />
    </div>
  );
}
```

**Step 4: Run test**

Run: `cd apps/studio && pnpm vitest run src/__tests__/edit-slide-over.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/spec-generation/EditSlideOver.tsx apps/studio/src/__tests__/edit-slide-over.test.tsx
git commit -m "[ABLP-2] feat(studio): add EditSlideOver panel with collapsed/default/expanded/minimized states"
```

---

### Task 6: Sequential Guided Review in ReviewScreen

Replace the free tab browsing + "Import to Project" with a sequential review flow: Topology → Agents → API Spec → Mocks → Create Project. Tabs ahead of the current step are dimmed. Integrate the EditSlideOver. Move Regenerate to a secondary position.

**Files:**

- Modify: `apps/studio/src/components/spec-generation/ReviewScreen.tsx` (major rewrite)

**Step 1: Rewrite ReviewScreen**

Replace the entire `ReviewScreen` component. Key changes:

- Remove all edit chat local state (`editMessages`, `editTyping`, etc.) — moved to store/`EditSlideOver`
- Replace tab click handler with review-step-aware logic:
  - Tabs with `stageIndex < currentReviewIndex` are clickable (go back)
  - Tab at `currentReviewIndex` is active
  - Tabs beyond are dimmed/disabled
- Replace action bar: remove "Import to Project", add "Looks good →" that calls `advanceReview()`
- When all 4 stages are reviewed (`reviewStep === null`), show "Create Project" button
- Integrate `EditSlideOver` as the right panel
- Move "Regenerate" to a "..." dropdown or secondary button
- Move "Deploy to Vercel" to only appear on Mocks tab
- Add checkmarks on reviewed tabs

The full ReviewScreen replacement is ~300 lines. The implementer should:

1. Remove local state: `editMessages`, `editTyping`, `showGuide`, `editFeedback`, `handleStartEdit`, `handleEditMessage`, `handleStopEdit`
2. Add store selectors: `reviewStep`, `reviewedStages`, `advanceReview`, `goBackToStage`, `editPanelState`
3. Use `reviewStep` to control `activeTab` — `activeTab` follows `reviewStep`
4. Tab rendering: add `Check` icon for reviewed stages, dim for future stages, `disabled` for stages past review step
5. Replace bottom action bar:
   - Left: "Regenerate" (secondary/ghost style) inside a dropdown or as a small icon button
   - Center: `EditSlideOver` (collapsed state renders the "Edit with Arch" button in the action bar)
   - Right: "Looks good → Review [NextStage]" or "Create Project" when all reviewed
6. For tab content, keep existing sub-components (`AgentsTab`, `OpenAPITab`, `MockDataTab`, `TopologyCanvas`)
7. Add `Download Spec` and `Upload Spec` buttons in OpenAPI tab header
8. Add `Deploy to Vercel` button in Mocks tab header

**Step 2: Run full test suite**

Run: `cd apps/studio && pnpm vitest run`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add apps/studio/src/components/spec-generation/ReviewScreen.tsx
git commit -m "[ABLP-2] feat(studio): rewrite ReviewScreen with sequential guided review and slide-over chat"
```

---

### Task 7: Persistent UI During Cascade

Update `SpecGenerationView` so that when cascade re-runs happen (edit → downstream regeneration), the ReviewScreen stays visible with a compact pipeline progress overlay instead of being replaced by the full PipelineStepper.

**Files:**

- Modify: `apps/studio/src/components/spec-generation/SpecGenerationView.tsx:207-254` (render logic)
- Create: `apps/studio/src/components/spec-generation/CascadeProgress.tsx`

**Step 1: Create CascadeProgress component**

This is a compact vertical progress indicator shown overlaid on the right side of ReviewScreen during cascade. Shows which stages are regenerating with spinners.

Create `apps/studio/src/components/spec-generation/CascadeProgress.tsx`:

```tsx
import { Check, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useSpecGenerationStore } from '../../store/spec-generation-store';
import type { SpecGenStage } from '../../types/arch';

const STAGE_LABELS: Record<SpecGenStage, string> = {
  topology: 'Topology',
  agents: 'Agents',
  openapi: 'API Spec',
  mocks: 'Mock Data',
};

const STAGE_ORDER: SpecGenStage[] = ['topology', 'agents', 'openapi', 'mocks'];

export function CascadeProgress() {
  const currentStage = useSpecGenerationStore((s) => s.currentStage);
  const stageResults = useSpecGenerationStore((s) => s.stageResults);
  const stageErrors = useSpecGenerationStore((s) => s.stageErrors);

  const RESULT_KEYS: Record<SpecGenStage, keyof typeof stageResults> = {
    topology: 'topology',
    agents: 'agents',
    openapi: 'openapi',
    mocks: 'mockProject',
  };

  return (
    <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-10 animate-fade-in">
      <div className="bg-background border border-default rounded-xl shadow-lg p-6 space-y-3">
        <p className="text-sm font-medium text-foreground mb-4">
          Regenerating downstream stages...
        </p>
        {STAGE_ORDER.map((stage) => {
          const hasResult = stageResults[RESULT_KEYS[stage]] !== null;
          const hasError = Boolean(stageErrors[stage]);
          const isRunning = currentStage === stage;

          return (
            <div key={stage} className="flex items-center gap-3">
              <div
                className={clsx(
                  'w-6 h-6 rounded-full flex items-center justify-center',
                  hasResult && 'bg-success/20 text-success',
                  isRunning && 'bg-accent-subtle text-accent',
                  hasError && 'bg-error/20 text-error',
                  !hasResult && !isRunning && !hasError && 'bg-background-muted text-subtle',
                )}
              >
                {hasResult ? (
                  <Check className="w-3.5 h-3.5" />
                ) : isRunning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                )}
              </div>
              <span
                className={clsx(
                  'text-sm',
                  hasResult ? 'text-success' : isRunning ? 'text-accent' : 'text-muted',
                )}
              >
                {STAGE_LABELS[stage]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 2: Update SpecGenerationView render logic**

In `SpecGenerationView`, change the render section so that:

- When `pipelineStatus === 'running'` AND `stageResults` has any non-null results (meaning this is a cascade, not a fresh run), render `ReviewScreen` with `CascadeProgress` overlaid
- When `pipelineStatus === 'running'` AND all `stageResults` are null (fresh run), render `PipelineStepper` as before

Replace the render section (around lines 207-254):

```tsx
// Idle — show form
if (pipelineStatus === 'idle') {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <QuickGenerateForm onSubmit={runPipeline} />
    </div>
  );
}

// Fresh pipeline run (no existing results) — full-screen stepper
const hasSomeResults =
  stageResults.topology !== null ||
  stageResults.agents !== null ||
  stageResults.openapi !== null ||
  stageResults.mockProject !== null;

if (pipelineStatus === 'running' && !hasSomeResults) {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8">
      <PipelineStepper />
      <p key={currentStage} className="text-sm text-muted mt-4 animate-fade-in">
        {getRunningStageDescription(currentStage)}
      </p>
    </div>
  );
}

// Error during fresh run — stepper + retry
if (pipelineStatus === 'error' && !hasSomeResults) {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 gap-4">
      <PipelineStepper />
      <p className="text-sm text-error">Generation encountered an error.</p>
      <div className="flex gap-3">
        <button
          onClick={handleRegenerate}
          className="px-4 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-default cursor-pointer"
        >
          Retry
        </button>
        <button
          onClick={reset}
          className="px-4 py-2 text-sm font-medium text-muted bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
        >
          Start Over
        </button>
      </div>
    </div>
  );
}

// Complete, cascade running, or error during cascade — show ReviewScreen
// Cascade overlay is handled inside ReviewScreen via CascadeProgress
return (
  <div className="h-full relative">
    <ReviewScreen onRegenerate={handleRegenerate} onImport={handleImport} />
    {pipelineStatus === 'running' && hasSomeResults && <CascadeProgress />}
  </div>
);
```

Add import at top:

```typescript
import { CascadeProgress } from './CascadeProgress';
```

**Step 3: Run tests + build**

Run: `cd apps/studio && pnpm vitest run && pnpm build`
Expected: All pass.

**Step 4: Commit**

```bash
git add apps/studio/src/components/spec-generation/CascadeProgress.tsx apps/studio/src/components/spec-generation/SpecGenerationView.tsx
git commit -m "[ABLP-2] feat(studio): keep ReviewScreen persistent during cascade with CascadeProgress overlay"
```

---

### Task 8: OpenAPI Download/Upload and Mocks Deploy Actions

Add download/upload buttons to the OpenAPI tab and move "Deploy to Vercel" to the Mocks tab.

**Files:**

- Modify: `apps/studio/src/components/spec-generation/ReviewScreen.tsx` (OpenAPITab and MockDataTab)

**Step 1: Add Download + Upload to OpenAPITab**

Modify the `OpenAPITab` sub-component to accept `onUpload` callback and render:

- **Download** button that serializes `spec` to JSON and triggers a browser download
- **Upload** button that opens a file picker, validates the uploaded file as valid OpenAPI 3.x (basic check: has `openapi`, `info`, `paths`), and calls `onUpload`

```tsx
function OpenAPITab({
  spec,
  onUploadSpec,
}: {
  spec: OpenAPISpec;
  onUploadSpec?: (spec: OpenAPISpec) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleDownload = () => {
    const json = JSON.stringify(spec, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.info.title.toLowerCase().replace(/\s+/g, '-')}-openapi.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      // Basic OpenAPI validation
      if (!parsed.openapi || !parsed.info || !parsed.paths) {
        setUploadError('Invalid OpenAPI spec: missing required fields (openapi, info, paths)');
        return;
      }
      onUploadSpec?.(parsed);
    } catch {
      setUploadError('Failed to parse file. Ensure it is valid JSON.');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{spec.info.title}</h3>
          <p className="text-xs text-muted">
            OpenAPI {spec.openapi} · v{spec.info.version}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
          {onUploadSpec && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted bg-background border border-default rounded-lg hover:bg-background-muted transition-default cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.yaml,.yml"
                className="hidden"
                onChange={handleUpload}
              />
            </>
          )}
        </div>
      </div>
      {uploadError && (
        <div className="px-3 py-2 bg-error/10 border border-error/20 rounded-lg text-xs text-error">
          {uploadError}
        </div>
      )}
      {/* Existing path list rendering... */}
    </div>
  );
}
```

Add `Download` import from lucide-react.

**Step 2: Move Deploy to MockDataTab**

Add deploy button + result display to `MockDataTab`:

```tsx
function MockDataTab({
  files,
  mockProject,
  onDeploy,
  isDeploying,
  deployResult,
  deployError,
}: {
  files: MockProjectFile[];
  mockProject: MockProjectBundle;
  onDeploy: () => void;
  isDeploying: boolean;
  deployResult: VercelDeployResult | null;
  deployError: string | null;
}) {
  // ... existing file tree + preview ...
  // Add deploy section at top:
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-default">
        <span className="text-sm font-medium text-foreground">{mockProject.projectName}</span>
        <button onClick={onDeploy} disabled={isDeploying} className="...deploy button styles...">
          {isDeploying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          Deploy to Vercel
        </button>
      </div>
      {deployResult && (/* deploy result banner */)}
      {deployError && (/* error banner */)}
      {/* existing file tree */}
    </div>
  );
}
```

Remove deploy button and deploy result banner from the main action bar.

**Step 3: Wire upload to store**

In `ReviewScreen`, add `handleUploadSpec`:

```typescript
const handleUploadSpec = useCallback(
  (uploaded: OpenAPISpec) => {
    commitEdit('openapi', uploaded);
  },
  [commitEdit],
);
```

Pass it to `OpenAPITab`:

```tsx
<OpenAPITab spec={stageResults.openapi} onUploadSpec={handleUploadSpec} />
```

**Step 4: Run tests + build**

Run: `cd apps/studio && pnpm vitest run && pnpm build`
Expected: All pass.

**Step 5: Commit**

```bash
git add apps/studio/src/components/spec-generation/ReviewScreen.tsx
git commit -m "[ABLP-2] feat(studio): add OpenAPI download/upload and move Deploy to Mocks tab"
```

---

### Task 9: Update Existing Tests

Update existing tests that reference the old ReviewScreen behavior, old action bar buttons, etc.

**Files:**

- Modify: `apps/studio/src/__tests__/arch-components.test.tsx` (update mocks if needed)
- Modify: `apps/studio/src/__tests__/spec-generation-store.test.ts` (already updated in Task 2)

**Step 1: Update tests**

Check for any tests that reference:

- `editMessages` local state in ReviewScreen (now in store)
- "Import to Project" button text (now sequential review)
- "Deploy to Vercel" in action bar (now in Mocks tab)
- `handleStartEdit` / `handleStopEdit` (now in EditSlideOver)

Update or remove references as needed. The store tests were already extended in Task 2.

**Step 2: Run full test suite**

Run: `cd apps/studio && pnpm vitest run`
Expected: All pass.

**Step 3: Final build**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add apps/studio/src/__tests__/
git commit -m "[ABLP-2] test(studio): update tests for Arch Edit UX redesign"
```

---

## Verification Checklist

After all tasks are complete:

1. `cd apps/studio && pnpm build` — compiles cleanly
2. `cd apps/studio && pnpm vitest run` — all tests pass
3. Manual: Open spec generation, complete pipeline, verify sequential review (Topology → Agents → API Spec → Mocks → Create Project)
4. Manual: Click "Edit with Arch" → slide-over opens → type a request → Arch returns plan → click "Go ahead" → Arch returns proposal → click "Apply" → cascade runs
5. Manual: During cascade, verify left panel stays visible with CascadeProgress overlay
6. Manual: On API Spec tab, verify Download and Upload buttons work
7. Manual: On Mocks tab, verify Deploy to Vercel button
8. Manual: Go back to a reviewed stage → re-edit → verify review resets forward
