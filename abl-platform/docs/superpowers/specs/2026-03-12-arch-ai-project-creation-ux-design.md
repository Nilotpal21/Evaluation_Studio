# Arch AI Project Creation UX Improvements

**Date:** 2026-03-12
**Status:** Approved
**Author:** Development Team

## Problem Statement

The current Arch AI project creation flow has UX friction:

1. **Redundant UI**: "Create Project" button in ArtifactPanel bottom-right duplicates what should be conversational
2. **Stuck state**: After project creation, page shows "redirecting..." but doesn't navigate
3. **Auto-navigation**: 5-second countdown auto-navigates without user control
4. **Unclear next action**: After creation, user doesn't have clear manual control over opening the project

## Goals

1. Remove explicit "Create Project" button - make creation purely conversational
2. Remove auto-navigation countdown - require explicit user action
3. Show clear "Open Project" action in success card
4. Disable chat input after creation with informative placeholder
5. Provide "Back to Home" escape hatch to start fresh conversation

## Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ ArchAIChatPage                                              │
│  ├── ArchAIChatPanel (chat + success banner)               │
│  │    ├── Messages                                          │
│  │    ├── CreateProjectApproval (success banner)           │
│  │    │    └── "Open Project" button → navigate            │
│  │    ├── Follow-ups (hidden when createdProjectId set)    │
│  │    ├── "Back to Home" (shown when createdProjectId set) │
│  │    └── ChatInputBar (disabled when createdProjectId)    │
│  └── ArtifactPanel (NO button, keep artifacts visible)     │
└─────────────────────────────────────────────────────────────┘

State: useArchAIStore.createdProjectId
  - null → normal chat enabled
  - string → chat disabled, show "Open project" placeholder + icon
```

### Component Changes

#### 1. ArtifactPanel.tsx

**Remove:**

- Action bar with "Create Project" button (lines 124-133)
- `onCreateProject` prop

**Keep:**

- Tab navigation and content display
- All artifact viewing functionality

**Before:**

```tsx
{
  (hasTopology || hasAgents) && !activeDynamicTab && (
    <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
      <button onClick={onCreateProject}>Create Project</button>
    </div>
  );
}
```

**After:**

```tsx
// Remove entire action bar section
```

#### 2. ArchAIChatPage.tsx

**Remove:**

- `onCreateProject` callback in ArtifactPanel (line 77-79)

**Before:**

```tsx
<ArtifactPanel
  onClose={() => setShowArtifactPanel(false)}
  onCreateProject={() => {
    window.dispatchEvent(new Event('arch-ai:create-project'));
  }}
/>
```

**After:**

```tsx
<ArtifactPanel onClose={() => setShowArtifactPanel(false)} />
```

#### 3. ArchAIChatPanel.tsx

**Remove:**

- Event listener for 'arch-ai:create-project' (lines 436-445)
- Auto-navigation countdown logic
- Follow-up suggestions when `createdProjectId` is set

**Add:**

- "Back to Home" button when `createdProjectId` is set
- Update follow-up logic to return empty array when project created

**Changes:**

A. Remove event listener:

```tsx
// DELETE lines 436-445
useEffect(() => {
  const handler = () => {
    sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: t('chat.create_project_message') }],
    });
  };
  window.addEventListener('arch-ai:create-project', handler);
  return () => window.removeEventListener('arch-ai:create-project', handler);
}, [sendMessage]);
```

B. Update follow-up derivation:

```tsx
// Modify deriveFollowUpKeys function (line 86)
function deriveFollowUpKeys(
  messages: UIMessage[],
  createdProjectId: string | null,
): readonly string[] {
  if (messages.length === 0) return HOME_SUGGESTION_KEYS;

  // NEW: If project created, hide all follow-ups
  if (createdProjectId) return [];

  // ... existing logic
}
```

C. Pass createdProjectId to follow-up logic:

```tsx
// Line 529 - update call
const followUpKeys = !isStreaming ? deriveFollowUpKeys(messages, createdProjectId) : [];
```

D. Add "Back to Home" button below input:

```tsx
// After ChatInputBar (around line 643)
<ChatInputBar
  onSend={handleSend}
  disabled={!!createdProjectId}
  isStreaming={isStreaming}
  onStop={stop}
  placeholder={
    createdProjectId
      ? t('chat.placeholder_created')
      : isStreaming
        ? t('chat.placeholder_streaming')
        : t('chat.placeholder_default')
  }
/>;

{
  /* NEW: Back to Home button when project created */
}
{
  createdProjectId && (
    <div className="flex justify-center mt-3">
      <button
        onClick={() => {
          useChatStore.getState().reset();
          useArchAIStore.getState().reset();
        }}
        className="text-xs text-foreground/50 hover:text-foreground transition-colors underline"
      >
        {t('chat.back_to_home')}
      </button>
    </div>
  );
}
```

#### 4. CreateProjectApproval.tsx

**Remove:**

- Auto-navigation countdown and useEffect (lines 92-112)
- Countdown display in button text (line 145)
- `navigatedRef` to prevent duplicate navigation

**Modify:**

- ProjectCreatedBanner to show static "Open Project" button
- Remove setCreatedProjectId call (it's already set by ArchAIChatPanel line 313)

**Before:**

```tsx
function ProjectCreatedBanner({ result, setCreatedProjectId }) {
  const [countdown, setCountdown] = useState(5);
  const navigatedRef = useRef(false);

  useEffect(() => {
    // Auto-navigation logic with countdown
  }, [result, setCreatedProjectId]);

  return (
    <button onClick={...}>
      {t('open_project', { countdown })} <ArrowRight />
    </button>
  );
}
```

**After:**

```tsx
function ProjectCreatedBanner({ result }) {
  return (
    <div className="my-3 flex items-center justify-between px-4 py-3 rounded-lg bg-green-500/[0.06] border border-green-500/20">
      <div className="flex items-center gap-2.5">
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
        <div>
          <span className="text-sm font-medium text-foreground">
            {t('created', { name: result.projectName })}
          </span>
          <span className="text-xs text-foreground/40 ml-2">
            {t('agents_saved', { count: result.stats.saved })}
          </span>
        </div>
      </div>
      <button
        onClick={() => {
          window.location.href = `/projects/${result.projectId}/arch-ai`;
        }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-green-500/10 text-green-700 text-xs font-medium hover:bg-green-500/20 transition-colors"
      >
        {t('open_project')} <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}
```

Component signature update:

```tsx
// Remove setCreatedProjectId and navigate props
function ProjectCreatedBanner({ result }: { result: CreateProjectResult }) {
  // ... implementation
}
```

And caller update (line 65-69):

```tsx
if (state === 'result' && result) {
  return <ProjectCreatedBanner result={result} />;
}
```

#### 5. ChatInputBar.tsx

**Add:**

- Visual indicator (arrow icon) when disabled due to project creation
- Check for `createdProjectId` to differentiate disabled states

**Implementation:**

```tsx
// Add prop to distinguish disabled reasons
interface ChatInputBarProps {
  onSend: (text: string, files: File[]) => void;
  disabled?: boolean;
  disabledReason?: 'project-created' | 'streaming' | 'other';
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
}

export function ChatInputBar({
  onSend,
  disabled,
  disabledReason,
  isStreaming,
  onStop,
  placeholder,
}: ChatInputBarProps) {
  // ... existing state

  return (
    <div className="relative">
      {/* Existing textarea */}
      <textarea
        disabled={disabled}
        placeholder={placeholder}
        // ... existing props
      />

      {/* NEW: Visual indicator when disabled due to project creation */}
      {disabled && disabledReason === 'project-created' && (
        <div className="absolute right-14 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-foreground/[0.04] text-xs text-foreground/40">
          <ArrowRight className="h-3 w-3" />
          <span>Open project</span>
        </div>
      )}

      {/* Existing buttons */}
    </div>
  );
}
```

Update caller in ArchAIChatPanel:

```tsx
<ChatInputBar
  onSend={handleSend}
  disabled={!!createdProjectId || isStreaming}
  disabledReason={createdProjectId ? 'project-created' : isStreaming ? 'streaming' : 'other'}
  isStreaming={isStreaming}
  onStop={stop}
  placeholder={
    createdProjectId
      ? t('chat.placeholder_created')
      : isStreaming
        ? t('chat.placeholder_streaming')
        : t('chat.placeholder_default')
  }
/>
```

### Data Flow

#### Project Creation Flow (After Changes)

```
1. User: "Build a restaurant finder"
   ↓
2. LLM generates topology + agents via tools
   ↓
3. ArtifactPanel shows topology/agents (NO button)
   ↓
4. User: "Create this project" (conversational)
   ↓
5. LLM calls create_project tool
   ↓
6. CreateProjectApproval shows pre-creation modal
   ↓
7. User clicks "Create Project" in modal
   ↓
8. Project created → result returned
   ↓
9. useArchAIStore.createdProjectId set (line 313)
   ↓
10. ProjectCreatedBanner shows with "Open Project" button
    ├── Follow-up suggestions hidden (empty array)
    ├── ChatInputBar disabled with "Open project" placeholder + icon
    └── "Back to Home" button appears below input
    ↓
11. User clicks "Open Project" → navigates to /projects/:id/arch-ai
    OR
    User clicks "Back to Home" → resets stores, starts fresh
```

#### State Management

**Single Source of Truth:** `useArchAIStore.createdProjectId`

```tsx
// When null → normal mode
createdProjectId = null
  → ChatInputBar: enabled
  → Follow-ups: shown
  → Back to Home: hidden
  → ArtifactPanel: visible (if artifacts exist)

// When string → project created mode
createdProjectId = "proj_abc123"
  → ChatInputBar: disabled with indicator
  → Follow-ups: hidden (empty array)
  → Back to Home: visible
  → ArtifactPanel: visible (shows created artifacts)
  → CreateProjectApproval: shows success banner
```

### Error Handling

#### Project Creation Failure

When `create_project` tool returns `{ success: false }`:

1. CreateProjectApproval shows error banner (existing behavior - line 115-122)
2. `createdProjectId` remains `null`
3. Chat input stays **enabled**
4. User can:
   - Ask LLM to retry: "Try again with fewer agents"
   - Modify design: "Change the supervisor agent"
   - Start fresh: "Let's try a different approach"

No special handling needed - existing behavior is correct per Option A.

#### Navigation Failure

If `window.location.href` fails (rare edge case):

```tsx
<button
  onClick={() => {
    try {
      window.location.href = `/projects/${result.projectId}/arch-ai`;
    } catch (err) {
      console.error('Navigation failed:', err);
      // Fallback: show error toast or retry button
      alert('Failed to navigate. Please try again.');
    }
  }}
>
  {t('open_project')} <ArrowRight />
</button>
```

### I18n Updates

Add/update translations in message files:

```json
{
  "arch_ai": {
    "chat": {
      "placeholder_created": "Open project to continue",
      "back_to_home": "← Back to Home",
      "create_project_message": "I'd like to create this project now"
    },
    "create_project": {
      "open_project": "Open Project",
      "created": "Project {name} created successfully!",
      "agents_saved": "{count} agents saved"
    }
  }
}
```

Note: `create_project_message` key can remain (used if user manually types similar intent) but the event listener that auto-sent it is removed.

### Testing Strategy

#### Unit Tests

1. **ArtifactPanel**
   - ✅ Renders topology/agents tabs
   - ✅ Does NOT render "Create Project" button
   - ✅ Does NOT accept `onCreateProject` prop

2. **CreateProjectApproval**
   - ✅ ProjectCreatedBanner shows static "Open Project" button
   - ✅ Does NOT show countdown timer
   - ✅ Does NOT auto-navigate
   - ✅ Navigates only when button clicked
   - ✅ Error banner shows when `success: false`

3. **ArchAIChatPanel**
   - ✅ Follow-ups return empty array when `createdProjectId` set
   - ✅ "Back to Home" button visible when `createdProjectId` set
   - ✅ "Back to Home" resets both stores
   - ✅ Does NOT listen for 'arch-ai:create-project' event

4. **ChatInputBar**
   - ✅ Shows indicator icon when `disabledReason === 'project-created'`
   - ✅ Does NOT show icon when disabled for other reasons
   - ✅ Placeholder text matches `createdProjectId` state

#### Integration Tests

1. **Full Project Creation Flow**

   ```typescript
   test('project creation flow - conversational trigger', async () => {
     // 1. User sends message
     await sendMessage('Build a restaurant finder');

     // 2. Wait for topology + agents
     await waitFor(() => expect(screen.getByText(/topology/i)).toBeInTheDocument());

     // 3. Verify NO "Create Project" button in artifact panel
     expect(screen.queryByText(/create project/i, { selector: 'button' })).not.toBeInTheDocument();

     // 4. User triggers creation conversationally
     await sendMessage('Create this project');

     // 5. Approve in modal
     const createButton = await screen.findByRole('button', { name: /create project/i });
     await userEvent.click(createButton);

     // 6. Verify success banner appears
     await waitFor(() => {
       expect(screen.getByText(/project.*created/i)).toBeInTheDocument();
     });

     // 7. Verify "Open Project" button (NOT "Open Project (5s)")
     const openButton = screen.getByRole('button', { name: /^open project$/i });
     expect(openButton).toBeInTheDocument();

     // 8. Verify NO auto-navigation after 5 seconds
     await new Promise((resolve) => setTimeout(resolve, 6000));
     expect(window.location.href).not.toContain('/projects/');

     // 9. Verify chat disabled with indicator
     expect(screen.getByPlaceholderText(/open project to continue/i)).toBeDisabled();
     expect(screen.getByText(/open project/i, { selector: 'span' })).toBeInTheDocument(); // indicator

     // 10. Verify "Back to Home" visible
     expect(screen.getByText(/back to home/i)).toBeInTheDocument();

     // 11. Verify follow-ups hidden
     expect(screen.queryByText(/follow.?ups/i)).not.toBeInTheDocument();

     // 12. Click "Open Project"
     await userEvent.click(openButton);

     // 13. Verify navigation
     await waitFor(() => {
       expect(window.location.href).toContain('/projects/proj_');
     });
   });
   ```

2. **Back to Home Flow**

   ```typescript
   test('back to home resets session', async () => {
     // ... create project as above

     // 1. Click "Back to Home"
     const backButton = screen.getByText(/back to home/i);
     await userEvent.click(backButton);

     // 2. Verify stores reset
     expect(useChatStore.getState().artifacts.topology).toBeNull();
     expect(useArchAIStore.getState().createdProjectId).toBeNull();

     // 3. Verify chat re-enabled
     expect(screen.getByPlaceholderText(/what would you like to build/i)).not.toBeDisabled();

     // 4. Verify artifact panel closed or empty
     // (depends on implementation - panel might close or show empty state)
   });
   ```

3. **Error Recovery**

   ```typescript
   test('creation failure keeps chat enabled', async () => {
     // Mock create_project to fail
     mockLLM.mockToolResult('create_project', {
       success: false,
       stats: { total: 5, saved: 0, failed: 5 },
     });

     // Trigger creation
     await sendMessage('Create this project');
     await clickCreateButton();

     // Verify error shown
     await waitFor(() => {
       expect(screen.getByText(/failed to create/i)).toBeInTheDocument();
     });

     // Verify chat STILL enabled
     const input = screen.getByRole('textbox');
     expect(input).not.toBeDisabled();

     // Verify NO "Back to Home" button (createdProjectId still null)
     expect(screen.queryByText(/back to home/i)).not.toBeInTheDocument();

     // User can retry
     await userEvent.type(input, 'Try again{enter}');
     // ... should work
   });
   ```

#### Manual Testing Checklist

- [ ] Generate topology + agents → ArtifactPanel has NO button
- [ ] Say "create this project" → LLM triggers create_project tool
- [ ] Approve in modal → success banner shows "Open Project" (no countdown)
- [ ] Wait 10 seconds → does NOT auto-navigate
- [ ] Chat input disabled with "Open project to continue" + icon visible
- [ ] Follow-up suggestions hidden
- [ ] "Back to Home" button visible below input
- [ ] Click "Open Project" → navigates to /projects/:id/arch-ai
- [ ] Click "Back to Home" → resets chat, can start new conversation
- [ ] Trigger creation failure → error shown, chat stays enabled
- [ ] ArtifactPanel stays open and interactive after creation

### Implementation Order

1. **Remove button** (lowest risk)
   - ArtifactPanel.tsx: remove action bar
   - ArchAIChatPage.tsx: remove onCreateProject prop

2. **Update CreateProjectApproval** (isolated component)
   - Remove countdown state and useEffect
   - Update button text to static "Open Project"
   - Remove setCreatedProjectId prop

3. **Update ArchAIChatPanel** (main coordination)
   - Remove event listener
   - Update deriveFollowUpKeys to check createdProjectId
   - Add "Back to Home" button

4. **Update ChatInputBar** (visual indicator)
   - Add disabledReason prop
   - Add indicator when project-created
   - Update caller to pass disabledReason

5. **Add i18n strings** (if needed)

6. **Write tests** (verify behavior)

### Rollback Plan

If issues arise:

1. Revert commits in reverse order (ChatInputBar → ArchAIChatPanel → CreateProjectApproval → ArtifactPanel)
2. All changes are UI-only, no database or API changes
3. No data loss risk - project creation logic unchanged
4. Old behavior: button + countdown can be restored by reverting

### Success Metrics

- User can create projects through conversation (no button needed)
- User explicitly controls when to open created project
- "Back to Home" usage indicates discoverability of reset
- Zero auto-navigation complaints
- Error recovery works smoothly (chat stays enabled)

## Non-Goals

- Changing project creation API or backend logic
- Adding undo/delete project functionality
- Changing artifact panel visualization
- Adding keyboard shortcuts
- Mobile-specific optimizations

## Future Enhancements

1. **Confirmation Dialog for "Back to Home"**
   - If artifacts exist, show "This will clear your current design. Continue?"
   - Prevents accidental loss of work

2. **Explicit State Machine**
   - Migrate to Approach 2 if complexity grows
   - Add states like 'deploying', 'testing' for richer flows

3. **Session Persistence**
   - Save draft topology/agents to localStorage
   - Restore on return to home page

4. **Keyboard Shortcuts**
   - `Cmd+Enter` on success banner → open project
   - `Esc` → back to home

5. **Analytics**
   - Track: conversation → creation rate
   - Track: open project vs back to home ratio
   - Track: time between creation and navigation

## Implementation Notes (Critical Fixes)

The following critical issues were identified in spec review and must be addressed during implementation:

### 1. Function Signature Consistency

**Issue:** `deriveFollowUpKeys` signature mismatch  
**Fix:** Update function signature AND all callers:

```tsx
// Function definition (line ~86)
function deriveFollowUpKeys(
  messages: UIMessage[],
  createdProjectId: string | null,
): readonly string[] {
  if (messages.length === 0) return HOME_SUGGESTION_KEYS;
  if (createdProjectId) return []; // NEW: hide all follow-ups when project created
  // ... existing logic
}

// Caller (line ~529)
const followUpKeys = !isStreaming ? deriveFollowUpKeys(messages, createdProjectId) : [];
```

### 2. Atomic Commit Requirement

**Critical:** The following changes MUST be in a single atomic commit to avoid broken intermediate states:

- Remove `onCreateProject` prop from ArtifactPanel.tsx interface
- Remove `onCreateProject` prop from ArchAIChatPage.tsx caller
- Remove event listener from ArchAIChatPanel.tsx (lines 436-445)

If done separately, the button will dispatch events that nothing listens to.

### 3. Store Reset Pattern

**Issue:** Direct `getState()` calls in JSX violate React patterns  
**Fix:** Extract hooks at component top:

```tsx
// At component top (after other hooks, line ~230)
const resetChat = useChatStore((s) => s.reset);
const resetArchAI = useArchAIStore((s) => s.reset);

// In JSX (line ~643+)
<button
  onClick={() => {
    resetChat();
    resetArchAI();
  }}
>
  {t('chat.back_to_home')}
</button>;
```

### 4. "Back to Home" Button Placement

**Issue:** Button will render outside centered container  
**Fix:** Place inside the `max-w-[720px]` container div:

```tsx
<div className="mx-auto w-full max-w-[720px] px-6 pb-6">
  {fileError && <div>...</div>}

  <ChatInputBar ... />

  {/* Back to Home INSIDE this container */}
  {createdProjectId && (
    <div className="flex justify-center mt-3">
      <button onClick={...}>Back to Home</button>
    </div>
  )}
</div>
```

### 5. setCreatedProjectId Duplication

**Issue:** Both ArchAIChatPanel (line 313) and CreateProjectApproval (line 95) set this  
**Resolution:**

- ArchAIChatPanel line 313 ALREADY sets it correctly in the tool result handler
- CreateProjectApproval's useEffect can be COMPLETELY REMOVED (no countdown needed)
- Remove `setCreatedProjectId` prop from ProjectCreatedBanner component signature

### 6. Component Prop Updates

**CreateProjectApproval.tsx:**

```tsx
// Remove these props from ProjectCreatedBanner:
function ProjectCreatedBanner({ result }: { result: CreateProjectResult }) {
  // Use navigateToProject helper (already exists at line 76-78)
  return (
    <button onClick={() => navigateToProject(result.projectId!)}>
      {t('open_project')} <ArrowRight />
    </button>
  );
}

// Caller (line 65-69)
if (state === 'result' && result) {
  return <ProjectCreatedBanner result={result} />;
}
```

**ChatInputBar.tsx:**

```tsx
// Add to interface:
interface ChatInputBarProps {
  // ... existing props
  disabledReason?: 'project-created' | 'streaming';
}

// Caller passes:
<ChatInputBar
  disabled={!!createdProjectId || isStreaming}
  disabledReason={createdProjectId ? 'project-created' : isStreaming ? 'streaming' : undefined}
/>;
```

### 7. Visual Indicator Positioning

**Issue:** `right-14` will overlap send button  
**Fix:** Position on left side instead:

```tsx
{
  disabled && disabledReason === 'project-created' && (
    <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-purple/[0.06] text-xs text-purple/60 pointer-events-none">
      <ExternalLink className="h-3 w-3" />
      <span>Project ready</span>
    </div>
  );
}
```

### 8. I18n File Location

**Action Required:** Before implementation, locate Studio's i18n message files.

**Discovery:**

```bash
# Find i18n configuration
find apps/studio/src -name "*.json" -path "*i18n*" -o -name "messages.json"
# Or check next-intl configuration
grep -r "next-intl" apps/studio/next.config.js apps/studio/src/i18n/
```

**Required keys:**

```json
{
  "arch_ai": {
    "chat": {
      "placeholder_created": "Open project to continue",
      "back_to_home": "← Back to Home"
    },
    "create_project": {
      "open_project": "Open Project"
    }
  }
}
```

### 9. Navigation Pattern

**Issue:** Spec shows inline `window.location.href` but helper exists  
**Fix:** Use existing `navigateToProject()` helper consistently:

```tsx
// In CreateProjectApproval.tsx
<button onClick={() => navigateToProject(result.projectId!)}>{t('open_project')}</button>
```

### 10. Implementation Order (Revised)

1. **Locate and add i18n keys** (prevents UI showing key strings)
2. **Atomic commit:** Remove button + event + props together
3. **Update ChatInputBar:** Add `disabledReason` prop and indicator
4. **Update CreateProjectApproval:** Remove countdown, use helper
5. **Update ArchAIChatPanel:** Extract hooks, add "Back to Home", update follow-ups
6. **Write tests**

### Pre-Implementation Checklist

- [ ] Verified i18n message file location in Studio
- [ ] All translation keys added BEFORE UI changes
- [ ] Confirmed `navigateToProject` helper exists at CreateProjectApproval.tsx:76-78
- [ ] Confirmed `createdProjectId` set by ArchAIChatPanel.tsx:313 (tool result handler)
- [ ] TypeScript `--strict` mode enabled for compilation checks
- [ ] All prop removals coordinated in single commit
