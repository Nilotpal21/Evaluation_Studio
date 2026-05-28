# Arch Onboarding Rewrite Design

**Date**: 2026-02-21
**Status**: Approved
**Scope**: Full rewrite of the Arch-guided onboarding flow in Studio

## Problem Statement

The current onboarding has three critical issues:

1. **State management**: InterviewPhase and RevealPhase use local `useState` for Arch conversations instead of the centralized arch-store. Conversation history is lost on navigation. The Arch workflow state machine (idle/contextualizing/responding/confirming/executing) used in the agent detail page is not used during onboarding — no proposals, no confirmations, no ABL validation.

2. **Project creation fails silently**: CreatePhase swallows agent save errors, creates empty/partial projects with success UI, uses deprecated ABL fallback syntax (`MODE:`), and has no rollback or retry mechanism. A parallel wizard path (NewProjectWizard) duplicates the same logic with different bugs.

3. **No tool review or API mocks**: The BUILD stage was designed but never implemented. Tools show only as name tags. The spec-generation pipeline (OpenAPI + mock deployment) exists as a separate flow but isn't integrated into onboarding.

## Decisions

| Decision                | Choice                                    | Rationale                                                     |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Canonical creation path | Onboarding (not Wizard)                   | More guided UX, single path to maintain                       |
| Tool/API mock review    | Integrate spec-generation into onboarding | Components already exist, just need composition               |
| Arch conversation state | arch-store (centralized)                  | Persistence, context continuity, workflow support             |
| Error handling          | Partial-with-warning                      | Create what succeeds, show per-agent status, warn on failures |
| Store consolidation     | lifecycle-store + arch-store only         | spec-generation-store's review logic moves to lifecycle-store |

## New Onboarding Flow

```
Welcome → Interview/Upload → Generating(topology) → Reveal(topology + adjust)
                                                       ↓ "Looks good!"
                                                   [inline progress: agents → openapi → mocks]
                                                       ↓
                                                    Review(3 tabs) → Create
```

### Phases

| Phase          | Description                                                                     | Arch Integration                                                                  |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **welcome**    | Landing screen. Two paths: conversation or upload.                              | None                                                                              |
| **interview**  | Arch interviews user one question at a time. Brief built from answers.          | arch-store conversation, keyed `'onboarding'`                                     |
| **upload**     | Drag-and-drop upload for specs/docs.                                            | Minor — file metadata in brief                                                    |
| **generating** | Full-screen loading while topology is generated. Progress stepper.              | API call to `/api/arch/generate`                                                  |
| **reveal**     | Dramatic topology reveal. Adjust sidebar uses full ArchChat with workflow.      | Full workflow: propose → confirm → apply. Context: `{ page: 'design', topology }` |
| **review**     | 3-tab review: Agents+Tools, API Spec, Mock Data. ArchChat sidebar per tab.      | Full workflow per tab. Context includes agentName, currentAbl, openapi spec       |
| **create**     | Project creation with per-agent status cards and partial-with-warning handling. | Conversation migrated from `'onboarding'` to `proj-${projectId}`                  |

### Phase transitions

```
welcome → interview       (click "Start a conversation")
welcome → upload          (click "I have specs to upload")
interview → generating    (all 5 questions answered)
upload → generating       (click "Generate Design")
generating → reveal       (topology generated)
reveal → review           ("Looks good!" + inline generation of agents/openapi/mocks)
review → create           (all 3 tabs reviewed, click "Create Project")
review → generating       (click "Regenerate" — re-runs full pipeline)
create → review           (click "Back to review")
```

## State Management

### lifecycle-store (simplified)

Remove wizard-specific state:

- **Remove**: `currentStage`, `completedStages`, `canAdvanceTo`, `startWizard`, `completeStage`, `setStage`
- **Rename**: `isWizardActive` → `isOnboardingActive`
- **Keep**: `onboardingPhase`, `interviewAnswers`, `brief`, `topology`, `generatedAgents`
- **Add**:
  - `specResults: { openapi: OpenAPISpec | null; mockProject: MockProjectBundle | null; deployResult: VercelDeployResult | null }`
  - `reviewStep: 'agents' | 'openapi' | 'mocks' | null` (which tab is being reviewed)
  - `reviewedTabs: Set<string>` (which tabs have been approved)
  - `creationWarnings: AgentCreationResult[]` (per-agent creation status)
  - `isGeneratingArtifacts: boolean` (inline generation flag for reveal → review)
  - `generationProgress: { stage: string; percent: number }` (for inline progress)

### arch-store usage

- Onboarding creates conversation keyed `'onboarding'`
- InterviewPhase writes Q&A as arch-store messages
- RevealPhase sidebar uses arch-store with full workflow state machine
- ReviewPhase sidebar uses arch-store with tab-specific context
- On project creation: conversation cloned from `'onboarding'` to `proj-${projectId}`

## Arch Integration with Full Workflow

### Reveal Phase sidebar

Uses ArchChat component with workflow support:

- Context: `{ page: 'design', topology: JSON.stringify(topology) }`
- Workflow: idle → contextualizing → responding → confirming → executing
- When user says "add a pharmacy agent": Arch proposes topology change, user sees Apply/Reject/Refine buttons
- Topology validated before applying

### Review Phase sidebar

ArchChat with tab-specific context:

- **Agents tab**: `{ page: 'agents', agentName, currentAbl }` — Arch proposes ABL modifications, validated via compilation
- **API Spec tab**: `{ page: 'openapi', openapi: spec }` — Arch proposes endpoint changes
- **Mocks tab**: `{ page: 'mocks', mockProject }` — Arch proposes mock data changes

### ABL validation during generation

1. Each generated agent's ABL passed through compiler validation
2. Compilation warnings/errors surfaced in Review Agents tab
3. Invalid ABL shows warning badge on agent card
4. User can ask Arch to fix issues via sidebar

## Error Handling — CreatePhase

### Sequence

```
1. Create project shell → if fails, STOP with error, don't navigate
2. For each agent:
   a. Create agent record → track success/failure
   b. Save DSL working copy → track success/failure
   c. Track compilation warnings
3. Save creation summary to arch-store
4. Navigate to project page:
   - All succeeded → clean navigation
   - Some failed → navigate with warning banner
```

### Per-agent status tracking

```typescript
type AgentCreationResult = {
  name: string;
  status: 'success' | 'failed' | 'warning';
  error?: string;
  compilationWarnings?: string[];
};
```

### CreatePhase UI

Shows a card per agent with live status during creation:

- Spinner while saving
- Green checkmark on success
- Yellow warning icon for compilation warnings
- Red X with error message on failure

After completion, shows summary with option to proceed (if any agents succeeded) or retry.

### Warning banner on project page

Navigate with transient warning state:

```
/projects/{id}?warnings=agent_a,agent_b
```

Project overview shows dismissible banner: "2 of 5 agents failed to create: Agent_A, Agent_B."

### Fallback ABL fix

Replace deprecated `MODE:` syntax with valid minimal ABL:

```
AGENT: ${name}

PERSONA: |
  You are ${name.replace(/_/g, ' ')}.

GOAL: "${description}"

EXECUTION:
  mode: ${executionMode}
```

### Conversation migration

On project creation, the `'onboarding'` conversation in arch-store is cloned to `proj-${projectId}`. This gives Arch context about how the project was created.

## Component Plan

### Files to rewrite (full):

| File                            | Changes                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `onboarding/ArchOnboarding.tsx` | Add 'review' phase, update back navigation for new flow                                  |
| `onboarding/InterviewPhase.tsx` | Wire to arch-store, use ArchChat component                                               |
| `onboarding/RevealPhase.tsx`    | Replace inline chat with ArchChat + workflow, add inline generation progress             |
| `onboarding/CreatePhase.tsx`    | Partial-with-warning, per-agent status cards, fixed fallback ABL, conversation migration |

### Files to create:

| File                         | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `onboarding/ReviewPhase.tsx` | 3-tab review (Agents+Tools, API Spec, Mock Data) with ArchChat sidebar |

### Files to modify:

| File                             | Changes                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `store/lifecycle-store.ts`       | Remove wizard state, add review tracking, specResults, creationWarnings |
| `onboarding/GeneratingPhase.tsx` | Better error handling, surface generation errors                        |
| `onboarding/WelcomePhase.tsx`    | No changes needed                                                       |
| `onboarding/UploadPhase.tsx`     | No changes needed                                                       |

### Files to deprecate:

| File                            | Reason                                |
| ------------------------------- | ------------------------------------- |
| `creation/NewProjectWizard.tsx` | Wizard path replaced by onboarding    |
| `lifecycle/IdeateStage.tsx`     | Replaced by InterviewPhase            |
| `lifecycle/DesignStage.tsx`     | Replaced by RevealPhase               |
| `creation/ReviewAndCreate.tsx`  | Replaced by ReviewPhase + CreatePhase |

## ReviewPhase Component Design

Three tabs, sequential review (must approve each before advancing):

### Agents Tab

- Expandable agent cards showing:
  - Agent name + execution mode badge
  - Tool list with parameter details (name, type, required)
  - Gather fields list
  - ABL code (expandable, syntax highlighted)
  - Compilation status badge (valid/warnings/errors)
- Reuses agent card pattern from spec-generation `AgentsTab`

### API Spec Tab

- OpenAPI 3.1.0 specification display
- Endpoint list (method + path + summary)
- Download/upload OpenAPI JSON
- Reuses `OpenAPITab` from spec-generation ReviewScreen

### Mock Data Tab

- File browser (left) + content viewer (right)
- Deploy to Vercel button
- Deployment status/URL display
- Reuses `MockDataTab` from spec-generation ReviewScreen

### Shared

- ArchChat sidebar (collapsible, 380px) with tab-specific context
- "Looks good → Review [next]" progression
- "Create Project" button after all tabs reviewed
- "Regenerate" button to re-run pipeline

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the Arch-guided onboarding flow with centralized state management, full Arch workflow integration, spec-generation review, and robust project creation error handling.

**Architecture:** The onboarding flow uses two stores (lifecycle-store + arch-store). All Arch conversations route through the centralized arch-store with the full workflow state machine (idle/contextualizing/responding/confirming/executing). A new ReviewPhase integrates spec-generation components (Agents+Tools, API Spec, Mock Data) between Reveal and Create. Project creation uses partial-with-warning error handling.

**Tech Stack:** React 18, Zustand, Framer Motion, TypeScript, ArchChat component, spec-generation pipeline

**Design doc:** `docs/plans/2026-02-21-arch-onboarding-rewrite-design.md`

---

## Task 1: Update Types — Add `review` to OnboardingPhase

**Files:**

- Modify: `apps/studio/src/types/arch.ts:13-19` (OnboardingPhase type)
- Modify: `apps/studio/src/types/arch.ts` (add AgentCreationResult type)

**Step 1: Add 'review' to OnboardingPhase union**

In `apps/studio/src/types/arch.ts`, update the `OnboardingPhase` type:

```typescript
export type OnboardingPhase =
  | 'welcome'
  | 'interview'
  | 'upload'
  | 'generating'
  | 'reveal'
  | 'review' // NEW
  | 'create';
```

**Step 2: Add AgentCreationResult type**

Below the `OnboardingPhase` type in the same file, add:

```typescript
export type AgentCreationStatus = 'pending' | 'saving' | 'success' | 'failed' | 'warning';

export interface AgentCreationResult {
  name: string;
  status: AgentCreationStatus;
  error?: string;
  compilationWarnings?: string[];
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new errors (existing errors are OK)

**Step 4: Commit**

```bash
git add apps/studio/src/types/arch.ts
git commit -m "feat(studio): add review phase and AgentCreationResult types to arch types"
```

---

## Task 2: Rewrite lifecycle-store — Remove wizard state, add review tracking

**Files:**

- Modify: `apps/studio/src/store/lifecycle-store.ts`

**Step 1: Rewrite lifecycle-store**

Replace the entire file. Key changes:

- Remove: `currentStage`, `completedStages`, `canAdvanceTo`, `startWizard`, `completeStage`, `setStage`, `STAGE_ORDER`, `stageIndex`, `selectIsStageCompleted`
- Rename: `isWizardActive` → `isOnboardingActive`
- Add: `specResults`, `reviewStep`, `reviewedTabs`, `creationResults`, `isGeneratingArtifacts`, `generationProgress`
- Add: `advanceReview()`, `goBackToTab()`, `setSpecResults()`, `setCreationResults()`, `startArtifactGeneration()`, `updateGenerationProgress()`, `finishArtifactGeneration()`
- Keep: `onboardingPhase`, `interviewAnswers`, `brief`, `topology`, `generatedAgents`, all their actions, `selectBriefCompleteness`

```typescript
import { create } from 'zustand';
import type {
  OnboardingPhase,
  ProjectBrief,
  TopologyData,
  GeneratedAgent,
  OpenAPISpec,
  MockProjectBundle,
  VercelDeployResult,
  AgentCreationResult,
} from '../types/arch';

// Review tab type — subset of spec-gen stages relevant to onboarding review
type ReviewTab = 'agents' | 'openapi' | 'mocks';

const REVIEW_TAB_ORDER: ReviewTab[] = ['agents', 'openapi', 'mocks'];

const REVIEW_TAB_LABELS: Record<ReviewTab, string> = {
  agents: 'Agents',
  openapi: 'API Spec',
  mocks: 'Mock Data',
};

interface SpecResults {
  openapi: OpenAPISpec | null;
  mockProject: MockProjectBundle | null;
  deployResult: VercelDeployResult | null;
}

interface GenerationProgress {
  stage: string;
  percent: number;
}

interface LifecycleState {
  // Onboarding
  isOnboardingActive: boolean;
  onboardingPhase: OnboardingPhase;
  interviewAnswers: Record<string, string>;

  // Project brief (populated during interview)
  brief: ProjectBrief;

  // Topology (proposed during generating, refined during reveal)
  topology: TopologyData | null;

  // Generated agents
  generatedAgents: GeneratedAgent[];

  // Spec results (openapi, mocks) — populated during reveal→review transition
  specResults: SpecResults;

  // Review tracking
  reviewStep: ReviewTab | null;
  reviewedTabs: ReviewTab[];

  // Inline artifact generation (reveal → review transition)
  isGeneratingArtifacts: boolean;
  generationProgress: GenerationProgress;

  // Creation results (per-agent status)
  creationResults: AgentCreationResult[];

  // Onboarding actions
  setOnboardingPhase: (phase: OnboardingPhase) => void;
  setInterviewAnswer: (key: string, value: string) => void;
  startOnboarding: () => void;
  exitOnboarding: () => void;

  // Brief actions
  updateBrief: (updates: Partial<ProjectBrief>) => void;
  resetBrief: () => void;

  // Topology actions
  setTopology: (topology: TopologyData) => void;
  clearTopology: () => void;

  // Agent actions
  setGeneratedAgents: (agents: GeneratedAgent[]) => void;
  clearGeneratedAgents: () => void;

  // Spec results actions
  setSpecResults: (updates: Partial<SpecResults>) => void;
  clearSpecResults: () => void;

  // Review actions
  advanceReview: () => void;
  goBackToTab: (tab: ReviewTab) => void;
  resetReview: () => void;

  // Artifact generation actions
  startArtifactGeneration: () => void;
  updateGenerationProgress: (progress: GenerationProgress) => void;
  finishArtifactGeneration: () => void;

  // Creation actions
  setCreationResults: (results: AgentCreationResult[]) => void;
  updateCreationResult: (name: string, update: Partial<AgentCreationResult>) => void;
  clearCreationResults: () => void;

  // Full reset
  reset: () => void;
}

const INITIAL_BRIEF: ProjectBrief = {
  domain: '',
  problemStatement: '',
  useCases: [],
  targetUsers: [],
  channels: [],
  tone: '',
  constraints: [],
  estimatedAgents: '',
  complexity: 'medium',
  uploadedFiles: [],
};

const INITIAL_SPEC_RESULTS: SpecResults = {
  openapi: null,
  mockProject: null,
  deployResult: null,
};

const INITIAL_STATE = {
  isOnboardingActive: false,
  onboardingPhase: 'welcome' as OnboardingPhase,
  interviewAnswers: {} as Record<string, string>,
  brief: INITIAL_BRIEF,
  topology: null as TopologyData | null,
  generatedAgents: [] as GeneratedAgent[],
  specResults: INITIAL_SPEC_RESULTS,
  reviewStep: 'agents' as ReviewTab | null,
  reviewedTabs: [] as ReviewTab[],
  isGeneratingArtifacts: false,
  generationProgress: { stage: '', percent: 0 },
  creationResults: [] as AgentCreationResult[],
};

export const useLifecycleStore = create<LifecycleState>((set, get) => ({
  ...INITIAL_STATE,

  // Onboarding
  setOnboardingPhase: (phase) => set({ onboardingPhase: phase }),
  setInterviewAnswer: (key, value) =>
    set((state) => ({
      interviewAnswers: { ...state.interviewAnswers, [key]: value },
    })),
  startOnboarding: () => set({ isOnboardingActive: true, onboardingPhase: 'welcome' }),
  exitOnboarding: () =>
    set({
      isOnboardingActive: false,
      onboardingPhase: 'welcome',
      interviewAnswers: {},
    }),

  // Brief
  updateBrief: (updates) =>
    set((state) => ({
      brief: { ...state.brief, ...updates },
    })),
  resetBrief: () => set({ brief: INITIAL_BRIEF }),

  // Topology
  setTopology: (topology) => set({ topology }),
  clearTopology: () => set({ topology: null }),

  // Agents
  setGeneratedAgents: (generatedAgents) => set({ generatedAgents }),
  clearGeneratedAgents: () => set({ generatedAgents: [] }),

  // Spec results
  setSpecResults: (updates) =>
    set((state) => ({
      specResults: { ...state.specResults, ...updates },
    })),
  clearSpecResults: () => set({ specResults: INITIAL_SPEC_RESULTS }),

  // Review
  advanceReview: () =>
    set((state) => {
      const currentStep = state.reviewStep;
      if (!currentStep) return {};
      const currentIndex = REVIEW_TAB_ORDER.indexOf(currentStep);
      const reviewed = state.reviewedTabs.includes(currentStep)
        ? state.reviewedTabs
        : [...state.reviewedTabs, currentStep];
      const nextStep =
        currentIndex < REVIEW_TAB_ORDER.length - 1 ? REVIEW_TAB_ORDER[currentIndex + 1] : null;
      return { reviewedTabs: reviewed, reviewStep: nextStep };
    }),
  goBackToTab: (tab) => set({ reviewStep: tab }),
  resetReview: () => set({ reviewStep: 'agents', reviewedTabs: [] }),

  // Artifact generation
  startArtifactGeneration: () =>
    set({ isGeneratingArtifacts: true, generationProgress: { stage: '', percent: 0 } }),
  updateGenerationProgress: (progress) => set({ generationProgress: progress }),
  finishArtifactGeneration: () =>
    set({ isGeneratingArtifacts: false, generationProgress: { stage: '', percent: 100 } }),

  // Creation
  setCreationResults: (results) => set({ creationResults: results }),
  updateCreationResult: (name, update) =>
    set((state) => ({
      creationResults: state.creationResults.map((r) =>
        r.name === name ? { ...r, ...update } : r,
      ),
    })),
  clearCreationResults: () => set({ creationResults: [] }),

  // Full reset
  reset: () => set(INITIAL_STATE),
}));

// Selectors
export const selectBriefCompleteness = (state: LifecycleState): number => {
  const { brief } = state;
  let filled = 0;
  const total = 6;
  if (brief.domain) filled++;
  if (brief.problemStatement) filled++;
  if (brief.useCases.length > 0) filled++;
  if (brief.targetUsers.length > 0) filled++;
  if (brief.channels.length > 0) filled++;
  if (brief.tone) filled++;
  return Math.round((filled / total) * 100);
};

export const selectAllReviewed = (state: LifecycleState): boolean =>
  state.reviewStep === null && state.reviewedTabs.length === REVIEW_TAB_ORDER.length;

export { REVIEW_TAB_ORDER, REVIEW_TAB_LABELS };
export type { ReviewTab, SpecResults, GenerationProgress };
```

**Step 2: Fix imports in consumers**

Search for all files importing from lifecycle-store and fix any broken references. Key consumers:

- `onboarding/ArchOnboarding.tsx` — uses `exitWizard` → `exitOnboarding`
- `onboarding/InterviewPhase.tsx` — uses `setOnboardingPhase`, `updateBrief`
- `onboarding/RevealPhase.tsx` — uses `setOnboardingPhase`, `setTopology`
- `onboarding/CreatePhase.tsx` — uses `exitWizard` → `exitOnboarding`, `setGeneratedAgents`
- `onboarding/GeneratingPhase.tsx` — uses `setTopology`, `setOnboardingPhase`
- `onboarding/WelcomePhase.tsx` — uses `setOnboardingPhase`
- `onboarding/UploadPhase.tsx` — uses `updateBrief`, `setOnboardingPhase`
- `lifecycle/IdeateStage.tsx` — wizard path, will be deprecated but needs to compile
- `lifecycle/DesignStage.tsx` — wizard path, will be deprecated
- `creation/ReviewAndCreate.tsx` — wizard path, will be deprecated
- `creation/NewProjectWizard.tsx` — wizard path, will be deprecated
- `spec-generation/SpecGenerationView.tsx` — uses `setTopology`, `setGeneratedAgents`, `completeStage`

For wizard-path files that reference removed methods (`completeStage`, `startWizard`, `isWizardActive`, etc.), add temporary stubs or update imports. The simplest approach: keep `isWizardActive` as an alias for `isOnboardingActive` in the store temporarily, and add no-op `startWizard`/`exitWizard`/`completeStage` methods that delegate to the new methods. This prevents breaking the wizard path while we build the new onboarding. Delete the stubs after wizard deprecation.

Actually, per the CLAUDE.md anti-pattern: "Delete stubs when real implementations exist." Instead, update the wizard-path consumers to use the new method names directly. They'll still work; we're just renaming.

**Step 3: Verify TypeScript compiles**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -40`
Expected: Fix any import errors in consumers

**Step 4: Commit**

```bash
git add apps/studio/src/store/lifecycle-store.ts apps/studio/src/components/
git commit -m "feat(studio): rewrite lifecycle-store for onboarding flow — remove wizard state, add review tracking"
```

---

## Task 3: Rewrite ArchOnboarding — Add review phase, update navigation

**Files:**

- Modify: `apps/studio/src/components/onboarding/ArchOnboarding.tsx`

**Step 1: Update the phase switch and back navigation**

```typescript
/**
 * ArchOnboarding Component
 *
 * Top-level orchestrator for the new project Arch experience.
 * Phases: welcome → interview/upload → generating → reveal → review → create
 */

import { useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ArrowLeft } from 'lucide-react';
import { WelcomePhase } from './WelcomePhase';
import { InterviewPhase } from './InterviewPhase';
import { UploadPhase } from './UploadPhase';
import { GeneratingPhase } from './GeneratingPhase';
import { RevealPhase } from './RevealPhase';
import { ReviewPhase } from './ReviewPhase';
import { CreatePhase } from './CreatePhase';
import { useLifecycleStore } from '../../store/lifecycle-store';
import { useNavigationStore } from '../../store/navigation-store';
import { transitions } from '../../lib/animation';
import type { OnboardingPhase } from '../../types/arch';

export function ArchOnboarding() {
  const { onboardingPhase, setOnboardingPhase, exitOnboarding } = useLifecycleStore();
  const { navigate } = useNavigationStore();

  const handleExit = useCallback(() => {
    exitOnboarding();
    navigate('/');
  }, [exitOnboarding, navigate]);

  const handleBack = useCallback(() => {
    switch (onboardingPhase) {
      case 'interview':
      case 'upload':
        setOnboardingPhase('welcome');
        break;
      case 'reveal':
        // Can't go back from reveal to generating — re-run would be needed
        setOnboardingPhase('welcome');
        break;
      case 'review':
        setOnboardingPhase('reveal');
        break;
      case 'create':
        setOnboardingPhase('review');
        break;
      default:
        handleExit();
    }
  }, [onboardingPhase, setOnboardingPhase, handleExit]);

  const showBack = onboardingPhase !== 'welcome' && onboardingPhase !== 'generating';

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Minimal header */}
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 sm:px-6 py-4">
        <div>
          {showBack && (
            <button
              onClick={handleBack}
              className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
              title="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          onClick={handleExit}
          className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
          title="Exit"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* Phase content */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={onboardingPhase}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={transitions.pageEnter}
            className="h-full"
          >
            {renderPhase(onboardingPhase)}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function renderPhase(phase: OnboardingPhase) {
  switch (phase) {
    case 'welcome':
      return <WelcomePhase />;
    case 'interview':
      return <InterviewPhase />;
    case 'upload':
      return <UploadPhase />;
    case 'generating':
      return <GeneratingPhase />;
    case 'reveal':
      return <RevealPhase />;
    case 'review':
      return <ReviewPhase />;
    case 'create':
      return <CreatePhase />;
    default:
      return <WelcomePhase />;
  }
}
```

**Step 2: Verify it compiles** (ReviewPhase doesn't exist yet — create a stub)

Create a minimal stub at `apps/studio/src/components/onboarding/ReviewPhase.tsx`:

```typescript
export function ReviewPhase() {
  return <div className="h-full flex items-center justify-center text-muted">Review phase — TODO</div>;
}
```

**Step 3: Commit**

```bash
git add apps/studio/src/components/onboarding/ArchOnboarding.tsx apps/studio/src/components/onboarding/ReviewPhase.tsx
git commit -m "feat(studio): update ArchOnboarding with review phase routing"
```

---

## Task 4: Rewrite RevealPhase — ArchChat with workflow + inline generation

**Files:**

- Modify: `apps/studio/src/components/onboarding/RevealPhase.tsx`

**Step 1: Rewrite RevealPhase**

Replace the inline chat sidebar with the real ArchChat component connected to arch-store. Add inline artifact generation progress (agents → openapi → mocks) triggered by "Looks good!".

Key changes:

- Use `useArchStore` for the sidebar conversation (keyed `'onboarding'`)
- Use `ArchChat` component with `workflowState`, `isWorkflowBusy`, `onWorkflowAction` props
- The `handleSendMessage` follows the same pattern as `ArchPanel.tsx:handleSendMessage` — sends to `/api/arch/chat` with `{ stage: 'design', context: { page: 'design', topology } }`
- The `handleWorkflowAction` follows `ArchPanel.tsx:handleWorkflowAction`
- "Looks good!" triggers `handleLooksGood()` which:
  1. Sets `startArtifactGeneration()` on lifecycle-store
  2. Runs the 3-stage pipeline (agents → openapi → mocks) with progress updates
  3. Stores results in lifecycle-store (`setGeneratedAgents`, `setSpecResults`)
  4. On completion: `finishArtifactGeneration()` and `setOnboardingPhase('review')`
- Shows a progress overlay at the bottom when `isGeneratingArtifacts` is true

The sidebar should use the ArchChat component from `../../arch/ArchChat` (not a bare inline chat). Pass `workflowState`, `isWorkflowBusy`, and `onWorkflowAction` props so the Apply/Reject/Refine buttons appear during confirming state.

See `apps/studio/src/components/arch/ArchPanel.tsx:195-296` for the exact `sendArchChat` and `handleWorkflowAction` patterns to follow.

**Step 2: Verify compilation and manual testing**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 3: Commit**

```bash
git add apps/studio/src/components/onboarding/RevealPhase.tsx
git commit -m "feat(studio): rewrite RevealPhase with ArchChat workflow and inline artifact generation"
```

---

## Task 5: Create ReviewPhase — 3-tab review with ArchChat sidebar

**Files:**

- Create: `apps/studio/src/components/onboarding/ReviewPhase.tsx`

**Step 1: Implement ReviewPhase**

This is a new component with 3 tabs (Agents, API Spec, Mock Data) and an ArchChat sidebar. It follows the same layout as `spec-generation/ReviewScreen.tsx` but reads from lifecycle-store instead of spec-generation-store.

Layout: Tab bar (top) + Content area (left) + ArchChat sidebar (right, collapsible 380px) + Action bar (bottom)

Tabs:

- **Agents**: Expandable agent cards with name, execution mode, tools (with params), gather fields, ABL code, compilation status. Port the `AgentsTab` from `spec-generation/ReviewScreen.tsx:229-260` and enhance with tool parameter details.
- **API Spec**: Reuse the `OpenAPITab` pattern from `spec-generation/ReviewScreen.tsx:262-370` — endpoint list, download, upload.
- **Mock Data**: Reuse the `MockDataTab` pattern from `spec-generation/ReviewScreen.tsx:372-454` — file browser, content viewer, deploy to Vercel.

ArchChat sidebar:

- Uses `useArchStore` with `activeConversationId: 'onboarding'`
- Context changes per tab: `{ page: 'agents' | 'openapi' | 'mocks', ... }`
- Full workflow support (same pattern as RevealPhase sidebar / ArchPanel)

Action bar:

- "Regenerate" button → `setOnboardingPhase('generating')` + `reset()` relevant state
- "Looks good → Review [next tab]" or "Create Project" (if all reviewed) → `advanceReview()` or `setOnboardingPhase('create')`

**Step 2: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 3: Commit**

```bash
git add apps/studio/src/components/onboarding/ReviewPhase.tsx
git commit -m "feat(studio): create ReviewPhase with 3-tab review and ArchChat sidebar"
```

---

## Task 6: Rewrite CreatePhase — Partial-with-warning error handling

**Files:**

- Modify: `apps/studio/src/components/onboarding/CreatePhase.tsx`

**Step 1: Rewrite CreatePhase**

Key changes from current:

1. **Per-agent status cards** — show a card per agent with live status (spinner → checkmark/warning/error)
2. **Partial-with-warning** — create project, save what succeeds, warn on failures
3. **Fixed fallback ABL** — use valid `EXECUTION:\n  mode: ${mode}` instead of deprecated `MODE:`
4. **Conversation migration** — clone `'onboarding'` conversation to `proj-${projectId}` in arch-store
5. **Better error reporting** — show which agents failed and why

The creation sequence:

```
1. setCreationResults(agents.map(a => ({ name: a.name, status: 'pending' })))
2. Create project shell → if fails, set error, return
3. For each agent:
   a. updateCreationResult(name, { status: 'saving' })
   b. Try: addAgentToProject + saveDslWorkingCopy
   c. On success: updateCreationResult(name, { status: 'success' })
   d. On error: updateCreationResult(name, { status: 'failed', error: err.message })
4. Clone arch-store conversation: 'onboarding' → proj-${projectId}
5. Save creation summary
6. If any succeeded: navigate to /projects/${id} (with ?warnings= if partial)
7. If all failed: show error, don't navigate
```

UI:

- Project name input + summary stats (same as current)
- Agent status list: cards with status icon, name, error message
- Create button with loading state
- After completion: "Go to Project" button (if succeeded) or "Retry" (if all failed)
- Warning summary showing failed agents

The fallback ABL template:

```typescript
const fallbackAbl = (name: string, executionMode: string, description: string) =>
  `AGENT: ${name}\n\nPERSONA: |\n  You are ${name.replace(/_/g, ' ')}.\n\nGOAL: "${description || `Handle ${name.replace(/_/g, ' ').toLowerCase()}`}"\n\nEXECUTION:\n  mode: ${executionMode}\n`;
```

**Step 2: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 3: Commit**

```bash
git add apps/studio/src/components/onboarding/CreatePhase.tsx
git commit -m "feat(studio): rewrite CreatePhase with per-agent status and partial-with-warning"
```

---

## Task 7: Rewrite InterviewPhase — Wire to arch-store

**Files:**

- Modify: `apps/studio/src/components/onboarding/InterviewPhase.tsx`

**Step 1: Wire InterviewPhase to arch-store**

Current InterviewPhase is a standalone Q&A flow that doesn't use arch-store. Rewrite to:

1. On mount, set `useArchStore.setActiveConversation('onboarding')` and add a welcome message if the conversation is empty
2. Each question + answer pair is written as arch-store messages:
   - Question: `{ role: 'arch', content: question.question }`
   - Answer: `{ role: 'user', content: answer }`
3. Keep the one-question-at-a-time centered UI (it's a good UX)
4. Brief updates still go to lifecycle-store as before
5. When all questions answered, transition to `'generating'`

The key pattern:

```typescript
const { addMessage, setActiveConversation, conversations } = useArchStore();

useEffect(() => {
  setActiveConversation('onboarding');
}, [setActiveConversation]);

const handleSubmit = (value: string) => {
  // ... existing brief update logic ...

  // Write Q&A to arch-store
  addMessage({
    id: `arch-q-${currentIndex}`,
    role: 'arch',
    content: question.question,
    timestamp: new Date().toISOString(),
    agentName: 'Arch',
  });
  addMessage({
    id: `user-a-${currentIndex}`,
    role: 'user',
    content: value,
    timestamp: new Date().toISOString(),
  });

  // ... advance to next question or generating phase ...
};
```

**Step 2: Verify compilation**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 3: Commit**

```bash
git add apps/studio/src/components/onboarding/InterviewPhase.tsx
git commit -m "feat(studio): wire InterviewPhase to arch-store for conversation persistence"
```

---

## Task 8: Update GeneratingPhase — Better error handling

**Files:**

- Modify: `apps/studio/src/components/onboarding/GeneratingPhase.tsx`

**Step 1: Improve error handling**

Current GeneratingPhase silently catches errors and falls through to Reveal. Update to:

1. If topology generation fails, show an error message with a "Try Again" button instead of silently proceeding to Reveal with no topology
2. Add the error to arch-store as an error message: `{ type: 'error', content: 'Generation failed: ...' }`
3. "Try Again" button retriggers the generation
4. Keep the same visual design (pulsing logo, status messages, progress bar)

**Step 2: Commit**

```bash
git add apps/studio/src/components/onboarding/GeneratingPhase.tsx
git commit -m "fix(studio): surface generation errors in GeneratingPhase instead of silent fallthrough"
```

---

## Task 9: Update callers of deprecated lifecycle-store methods

**Files:**

- Modify: `apps/studio/src/components/creation/NewProjectWizard.tsx`
- Modify: `apps/studio/src/components/creation/ReviewAndCreate.tsx`
- Modify: `apps/studio/src/components/lifecycle/IdeateStage.tsx`
- Modify: `apps/studio/src/components/lifecycle/DesignStage.tsx`
- Modify: `apps/studio/src/spec-generation/SpecGenerationView.tsx`
- Modify: Any other files importing removed methods

**Step 1: Update wizard-path files**

These files reference `startWizard`, `exitWizard`, `isWizardActive`, `completeStage`, `currentStage`, `setStage`, `completedStages`. Update them:

- `exitWizard()` → `exitOnboarding()`
- `isWizardActive` → `isOnboardingActive`
- `startWizard()` → `startOnboarding()`
- `completeStage('ideate')` → `setOnboardingPhase('generating')` (or appropriate phase)
- `currentStage` → `onboardingPhase`
- `setStage(x)` → `setOnboardingPhase(x)`

For `SpecGenerationView.tsx` which calls `completeStage`, update to use the appropriate lifecycle-store action or remove the call if it's no longer needed (the spec-generation view is embedded in IdeateStage's "Quick Generate" mode — this will need to work with the new store API).

**Step 2: Verify TypeScript compiles with no errors**

Run: `cd apps/studio && npx tsc --noEmit --pretty 2>&1 | head -50`
Fix any remaining import/type errors.

**Step 3: Commit**

```bash
git add apps/studio/src/components/
git commit -m "refactor(studio): update wizard-path files for new lifecycle-store API"
```

---

## Task 10: Integration test — Full flow verification

**Step 1: Run the build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter studio 2>&1 | tail -20`
Expected: Build succeeds

**Step 2: Run existing tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm test --filter studio 2>&1 | tail -30`
Expected: All existing tests pass (new components don't have tests yet — that's OK for this rewrite)

**Step 3: Manual verification checklist**

Start the dev server and verify:

1. Welcome phase renders with "Start a conversation" and "I have specs to upload" buttons
2. Interview phase shows one question at a time, brief updates appear
3. Generating phase shows progress animation, transitions to Reveal
4. Reveal phase shows topology with "Looks good!" and "Let me adjust..." buttons
5. "Let me adjust..." opens sidebar with full ArchChat (Apply/Reject/Refine buttons work)
6. "Looks good!" shows inline progress bar, transitions to Review
7. Review phase shows 3 tabs (Agents, API Spec, Mock Data) with ArchChat sidebar
8. "Create Project" shows per-agent status cards with live progress
9. Partial failures show warning banner
10. Navigation to project page works

**Step 4: Commit any fixes**

```bash
git add .
git commit -m "fix(studio): integration fixes for onboarding rewrite"
```

---

## Task 11: Deprecate wizard-path files

**Step 1: Add deprecation comments**

Add `@deprecated` JSDoc comments to:

- `creation/NewProjectWizard.tsx`
- `creation/ReviewAndCreate.tsx`
- `lifecycle/IdeateStage.tsx`
- `lifecycle/DesignStage.tsx`

Example:

```typescript
/**
 * @deprecated Use ArchOnboarding flow instead. This wizard path is being phased out.
 * See docs/plans/2026-02-21-arch-onboarding-rewrite-design.md
 */
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/creation/ apps/studio/src/components/lifecycle/
git commit -m "chore(studio): deprecate wizard-path components in favor of onboarding flow"
```
