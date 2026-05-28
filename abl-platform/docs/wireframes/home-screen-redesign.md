# Home Screen Redesign - SearchAI

**Problem Statement**: Home screen shows stale static stats. No differentiation between uploads vs connectors. "Waiting" state creates dead-end. Upload/Add Source buttons disappear after first use.

**Solution**: Action-oriented smart dashboard with persistent quick actions and source breakdown.

---

## Wireframe: New Home Screen Layout

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ [←] testscreens        1 Sources  2 Documents  1 Chunks    [Settings] ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

┌────────────────────────────────────────────────────────────────────────┐
│ [Home] [Data] [Intelligence] [Search & Test]                          │
└────────────────────────────────────────────────────────────────────────┘


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🎯 QUICK ACTIONS (Always Visible - Sticky)                            ┃
┠────────────────────────────────────────────────────────────────────────┨
┃  ┌──────────────────────────┐  ┌──────────────────────────┐          ┃
┃  │  📄  Upload Files        │  │  🔌  Add Source          │          ┃
┃  │                          │  │                          │          ┃
┃  │  Drop files or browse    │  │  Connect data sources    │          ┃
┃  └──────────────────────────┘  └──────────────────────────┘          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 📊 KNOWLEDGE BASE STATS (With Context)                                ┃
┠────────────────────────────────────────────────────────────────────────┨
┃                                                                        ┃
┃  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐   ┃
┃  │   🗂️  Sources    │  │  📄  Documents   │  │  🧩  Chunks      │   ┃
┃  │                  │  │                  │  │                  │   ┃
┃  │       1          │  │       2          │  │       1          │   ┃
┃  │   ───────        │  │   ───────        │  │   ───────        │   ┃
┃  │  Manual: 1       │  │  Indexed: 2      │  │  Coverage: 100%  │   ┃
┃  │  Connectors: 0   │  │  Processing: 0   │  │  Last: 2h ago    │   ┃
┃  │                  │  │  Failed: 0       │  │                  │   ┃
┃  │  [View All →]    │  │  [View All →]    │  │  [View All →]    │   ┃
┃  └──────────────────┘  └──────────────────┘  └──────────────────┘   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🗂️  YOUR SOURCES                                          [View All] ┃
┠────────────────────────────────────────────────────────────────────────┨
┃                                                                        ┃
┃  ┌──────────────────────────────────────────────────────────────────┐ ┃
┃  │  📁  Default                                                      │ ┃
┃  │  Manual Upload                                                    │ ┃
┃  │  ├─ 2 documents  •  Last updated: 2 hours ago                    │ ┃
┃  │  └─ Status: ✅ Active                                            │ ┃
┃  │                                        [📤 Upload More]  [⚙️ Manage] │ ┃
┃  └──────────────────────────────────────────────────────────────────┘ ┃
┃                                                                        ┃
┃  ┌──────────────────────────────────────────────────────────────────┐ ┃
┃  │  ➕  Add your first connector                                     │ ┃
┃  │                                                                   │ ┃
┃  │  Connect SharePoint, web pages, databases, or APIs               │ ┃
┃  │  to automatically sync content into your knowledge base.          │ ┃
┃  │                                                                   │ ┃
┃  │        [🔌 Browse Connectors]                                    │ ┃
┃  └──────────────────────────────────────────────────────────────────┘ ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛


┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ⚠️  Needs Attention          ┃  ┃ 📝  Recent Activity           ┃
┠──────────────────────────────┨  ┠───────────────────────────────┨
┃                              ┃  ┃                               ┃
┃  ✅ All systems healthy      ┃  ┃  • 2 docs indexed             ┃
┃     Your knowledge base is   ┃  ┃    2 hours ago                ┃
┃     running smoothly.        ┃  ┃                               ┃
┃                              ┃  ┃  • Source "Default" updated   ┃
┃  [View Details →]            ┃  ┃    2 hours ago                ┃
┃                              ┃  ┃                               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

---

## Key Design Changes

### 1. **Persistent Quick Actions** (NEW)

```
Always visible at the top, regardless of state:
- Upload Files button (opens upload dialog)
- Add Source button (opens source selector)
```

**Why**: Solves #12 - actions never disappear after first use

### 2. **Stats with Context** (ENHANCED)

```
Before:                    After:
┌──────────┐              ┌──────────────────┐
│ Sources  │              │   🗂️  Sources    │
│    1     │              │        1         │
└──────────┘              │   ───────        │
                          │  Manual: 1       │
                          │  Connectors: 0   │
                          └──────────────────┘
```

**Why**: Shows breakdown of source types + status breakdown

### 3. **Your Sources Section** (NEW)

```
Shows active sources as cards:
- Manual upload sources → "Upload More" CTA
- Connector sources → Config/status
- "Add first connector" card if none exist
```

**Why**: Makes sources interactive, shows what's contributing to KB

### 4. **Remove "Waiting" State** (REMOVED)

```
Before:
Setup → Waiting (dead-end) → Operations

After:
Setup → Operations (with actions always visible)
```

**Why**: Solves #13 - no more dead-end screens

---

## State Machine Changes

### Current States:

```
┌─────────┐     ┌─────────┐     ┌──────────┐     ┌────────────┐
│ Setup   │ ──→ │ Waiting │ ──→ │ Progress │ ──→ │ Operations │
│ (no src)│     │ (0 docs)│     │ (index)  │     │ (ready)    │
└─────────┘     └─────────┘     └──────────┘     └────────────┘
                     ↑
                 PROBLEM: Dead-end, no actions
```

### New States:

```
┌─────────┐     ┌────────────┐
│ Setup   │ ──→ │ Operations │ (with persistent actions)
│ (no src)│     │ (any state)│
└─────────┘     └────────────┘
                     ↓
                ┌──────────┐
                │ Progress │ (overlay during indexing)
                └──────────┘
```

---

## Component Breakdown

### 1. QuickActionsBar (NEW)

```tsx
<div className="sticky top-0 z-10 bg-background border-b">
  <div className="flex gap-4 p-4">
    <UploadButton />
    <AddSourceButton />
  </div>
</div>
```

### 2. StatsRow (ENHANCED)

```tsx
<div className="grid grid-cols-3 gap-4">
  <StatCard
    title="Sources"
    value={sourceCount}
    breakdown={{
      Manual: manualCount,
      Connectors: connectorCount,
    }}
    onClick={() => navigate('data', 'sources')}
  />
  <StatCard
    title="Documents"
    value={docCount}
    breakdown={{
      Indexed: indexedCount,
      Processing: processingCount,
      Failed: failedCount,
    }}
    onClick={() => navigate('data', 'documents')}
  />
  <StatCard
    title="Chunks"
    value={chunkCount}
    breakdown={{
      Coverage: '100%',
      'Last indexed': '2h ago',
    }}
    onClick={() => navigate('data', 'chunks')}
  />
</div>
```

### 3. SourceCards (NEW)

```tsx
<section>
  <h2>Your Sources</h2>
  {sources.map((source) => (
    <SourceCard
      key={source._id}
      source={source}
      onUpload={() => openUploadDialog(source._id)}
      onManage={() => openSourceDetail(source._id)}
    />
  ))}
  {!hasConnectors && <AddConnectorCard onClick={() => navigate('data', 'sources')} />}
</section>
```

### 4. Activity & Attention (KEEP)

Existing components, no changes needed.

---

## User Flows

### Flow 1: First Time User

```
1. Sees Setup Guide with drop zone
2. Drops files OR clicks "Add Source"
3. Files upload → Immediately see Operations Dashboard
   - Quick Actions still visible at top
   - Source card shows "Default" with uploaded files
   - Stats show 1 source (Manual: 1, Connectors: 0)
   - "Add first connector" card visible
4. Can immediately upload more OR add connector
```

### Flow 2: Daily User

```
1. Lands on Operations Dashboard
2. Sees at a glance:
   - 3 sources (2 manual, 1 SharePoint)
   - 150 documents (145 indexed, 5 processing)
   - 1,234 chunks (coverage 98%)
3. Clicks "Upload Files" → Adds more docs
4. Clicks SharePoint source card → Sees sync status
5. Clicks "Add Source" → Adds new connector
```

### Flow 3: User with Errors

```
1. Sees "Needs Attention" card with red indicator
2. "2 documents failed indexing"
3. Clicks → Navigates to Data tab with failed filter applied
4. Fixes documents
5. Returns to Home → "All systems healthy"
```

---

## Implementation Plan

### Phase 1: Remove "Waiting" State

- [ ] Delete `WaitingForContent.tsx`
- [ ] Update state machine in `HomeSection.tsx`
- [ ] Merge "waiting" → "operations" logic

### Phase 2: Add Persistent Actions

- [ ] Create `QuickActionsBar.tsx`
- [ ] Add to `OperationsDashboard.tsx`
- [ ] Wire up to existing upload/add-source dialogs

### Phase 3: Enhance Stats

- [ ] Update `StatCard.tsx` to show breakdown
- [ ] Calculate source type breakdown
- [ ] Calculate document status breakdown

### Phase 4: Source Cards Section

- [ ] Create `SourceCard.tsx`
- [ ] Create `AddConnectorCard.tsx`
- [ ] Add to `OperationsDashboard.tsx`
- [ ] Wire up actions

---

## Design Validation

### ✅ Solves User Problems:

- [x] Always actionable - Quick Actions always visible
- [x] Source differentiation - Manual vs Connectors breakdown
- [x] No dead-ends - "Waiting" state removed
- [x] Context-rich - Stats show WHY, not just WHAT

### ✅ Follows RAG Best Practices:

- [x] Source-centric view (sources are the truth)
- [x] Status visibility (health checks upfront)
- [x] Quick iteration (upload more anytime)
- [x] Progressive disclosure (summary → drill-down)

### ✅ Aligns with Design System:

- [x] Uses existing Card/Button/Badge components
- [x] Follows grid layout patterns
- [x] Maintains consistent spacing/colors
- [x] Mobile responsive (grid cols adjust)

---

## Metrics to Track

Post-launch, track:

1. **Action adoption**: % of users clicking Upload/Add Source from Home
2. **Source diversity**: % of KBs with connectors vs manual-only
3. **Time to second source**: Days from first source to adding second
4. **Dead-end prevention**: Reduction in users stuck at "waiting" state

---

## Next Steps

1. **Review this wireframe** with team
2. **Validate** with 2-3 power users
3. **Prioritize phases** (Phase 1 is quick win)
4. **Implement & ship** Phase 1-2 first (removes pain)
5. **Iterate** on Phases 3-4 based on usage
