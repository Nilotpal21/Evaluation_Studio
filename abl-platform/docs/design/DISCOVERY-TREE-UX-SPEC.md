# Discovery Tree UX Specification

## Executive Summary

The discovery tree is the core interface where users understand a website's structure and decide what to crawl. This spec redesigns it from a developer debug view into a user-first experience that answers one question clearly: **"What content does this site have, and which parts do I want?"**

The redesign removes all developer classification badges, makes exploration a first-class visible action, resolves orphan node presentation, and provides guided user journeys for both live discovery and post-discovery selection.

---

## Design Principles

1. **Show the website, not the crawler.** Users care about "Printers > All-In-Ones > ET Series." They do not care about HTTP vs Browser, Nav vs BFS, or link frequency counts.
2. **Progressive revelation over information dump.** Start with the simplest useful view. Details are available on demand, never forced.
3. **Every node has a clear next action.** The user should never stare at a node wondering "what do I do with this?"
4. **The tree IS the selection.** Checking a node means "crawl this." The tree is both the map and the shopping cart.

---

## Part 1: Badge and Label Strategy

### What to REMOVE from the default view

Every badge listed below is currently shown inline on every tree row. None of them help a user decide what to crawl.

| Current Badge                                              | Why It Exists                | Why Users Don't Need It                          | Action                                     |
| ---------------------------------------------------------- | ---------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `HTTP` / `Browser`                                         | Render method classification | User doesn't choose rendering; system does       | **Remove entirely**                        |
| `Nav` / `BFS` / `Seed` / `Primary` / `Breadcrumb` / `User` | Discovery source             | How a URL was found doesn't affect what to crawl | **Remove entirely**                        |
| `Global`                                                   | Link appears on many pages   | Useful signal but wrong presentation             | **Replace with visual treatment**          |
| `leaf` / `hub` / `mixed`                                   | Page role classification     | Developer concept; users think in folders/pages  | **Remove entirely**                        |
| `virtual`                                                  | Synthetic folder node        | Implementation detail                            | **Remove entirely** (use folder icon)      |
| `3 pg` (childPageCount)                                    | Pages under a folder         | Useful but redundant with page count badge       | **Merge into page count**                  |
| Link frequency (`[link icon] 5`)                           | How many pages link here     | SEO metric, not selection signal                 | **Remove from tree; move to detail panel** |
| Visited dot (green circle)                                 | BFS visited this page        | Discovery internals                              | **Remove entirely**                        |

### What to KEEP (simplified)

| Element           | Current Form                       | New Form                                           | When Shown                         |
| ----------------- | ---------------------------------- | -------------------------------------------------- | ---------------------------------- |
| Page count        | `37 pages` green badge             | `37 pages` -- right-aligned, muted style           | After node is explored             |
| Auto badge        | Sparkle icon + "Auto" purple badge | `Suggested` -- subtle text label, no badge chrome  | Nodes matching sample URL patterns |
| Explored check    | Green check badge                  | No separate indicator; page count IS the indicator | Never as separate element          |
| Error state       | Red error text + Retry button      | Red text "Could not reach" + Retry link            | On error nodes                     |
| Exploring spinner | Blue spinner icon                  | Inline spinner replacing the folder/file icon      | During exploration                 |

### Node Visual Elements (new design)

Each tree row contains exactly these elements, left to right:

```
[indent] [chevron] [icon] [checkbox?] [label]                    [status area]
```

**Maximum 6 visual elements per row** (down from up to 10).

Details:

- **Indent**: `depth * 20px` padding (unchanged)
- **Chevron**: Expand/collapse for nodes with children. Empty space for leaves.
- **Icon**: Folder (closed/open) for parent nodes. File icon for leaves. Spinner replaces icon during exploration.
- **Checkbox**: Shown in select mode for explorable/explored nodes. Hidden in live mode.
- **Label**: The node name. Truncated with ellipsis. Full URL in tooltip on hover.
- **Status area** (right-aligned): One of:
  - Page count (e.g., "37 pages") for explored nodes
  - "Suggested" text for auto-matched nodes
  - "Explore" button for unexplored nodes (always visible, not hover-only)
  - Spinner + "Exploring..." for actively exploring nodes
  - "Could not reach -- Retry" for error nodes
  - Empty for structural folder nodes with no URL

---

## Part 2: Making Exploration Discoverable

### The Core Problem

Currently, the only way to explore a node deeper is a compass icon that appears **on hover**. With hundreds of nodes, users never discover this interaction exists.

### Solution: Visible Explore Affordance

**Unexplored nodes with a URL show a persistent "Explore" button in the status area.**

This is not a hover-only action. It is always visible. The button uses ghost styling (text + subtle border) to avoid visual heaviness while remaining scannable.

```
  v [folder] [ ] Scanners                                    [Explore]
  v [folder] [ ] Wide Format                                 [Explore]
    [file]   [ ] SureColor T-Series                          [Explore]
```

When the user clicks Explore:

1. Button text changes to spinner + "Exploring..."
2. System crawls the node and its immediate children
3. On completion: button disappears, replaced by page count ("14 pages")
4. Checkbox appears (node is now selectable)
5. Any discovered children appear as new child nodes in the tree

### Explore Affordance by Node State

| State                | Status Area Content              | Interaction                          |
| -------------------- | -------------------------------- | ------------------------------------ |
| Unexplored (has URL) | `[Explore]` button               | Click to explore                     |
| Unexplored (no URL)  | _(empty)_                        | Expand to see children               |
| Auto-matched         | `Suggested` label                | Automatically queued for exploration |
| Exploring            | Spinner + "Exploring..."         | Wait; no interaction needed          |
| Explored             | `{N} pages`                      | Click checkbox to include/exclude    |
| Error                | `Could not reach` + `Retry` link | Click Retry to re-attempt            |

### Keyboard Support

- `Enter` on a focused unexplored node triggers Explore
- `Space` on a focused node toggles the checkbox (select mode)
- `Arrow keys` navigate the tree
- `Right arrow` expands; `Left arrow` collapses

---

## Part 3: Handling Orphan Nodes

### The Problem

Some discovered URLs don't fit the tree hierarchy. FAQ pages linked from product pages, sitemap-only URLs with unrelated paths, footer links to corporate pages. Currently these appear as flat root-level items, breaking the tree's visual structure.

### Solution: "Other Pages" Collector Group

All nodes that cannot be placed in the URL-path hierarchy are grouped under a single collapsible section at the bottom of the tree called **"Other Pages"**.

```
  v [folder] Support
      v [folder] Printers
          v [folder] All-In-Ones
              ...
      > [folder] Scanners
      > [folder] Projectors

  v [folder] Other Pages                                     12 items
      [file] Epson Connect Setup                             [Explore]
      [file] Remote Print Setup                              [Explore]
      [file] FAQs - General Printing                         [Explore]
      ...
```

**Rules for "Other Pages":**

1. A node is "orphaned" if its URL path shares no common prefix (beyond domain root) with any other non-orphaned node in the tree.
2. The group is collapsed by default when it has more than 5 items.
3. The group header shows the count: "Other Pages (12 items)".
4. Inside the group, nodes are sorted alphabetically by label.
5. If a user explores an orphan node and it reveals children that fit the main tree, those children move to the main tree. The explored orphan stays in "Other Pages" but gains a cross-reference: "See also: Support > Printers > ET-2400".

### Global Navigation Links

Links from site-wide navigation (header, footer, mega-menu) that appear on >30% of pages get special treatment:

- **Not shown by default.** Global nav links (/Store, /Ink, /Contact Us) clutter the tree without adding selection value.
- **Available via "Show site-wide links" toggle** in the tree header for users who want them.
- When shown, they appear in a separate "Site Navigation" group above "Other Pages", visually dimmed (60% opacity).
- They are deselected by default and have a tooltip: "This link appears across the entire site. Select only if you want to crawl this section."

---

## Part 4: Live Mode (During Discovery)

### Layout

```
+------------------------------------------------------------------+
|  Discovering epson.com                              [Stop]        |
|  ----------------------------------------------------------------|
|  Progress: 127 pages found -- 34 visited -- Phase 2 of 4         |
|  [=========>                                              ] 34%   |
|  ----------------------------------------------------------------|
|  Activity                                                         |
|  09:55:48  Extracting site navigation...                          |
|  09:55:52  Found 47 navigation categories                         |
|  09:55:53  Visiting /Support/Printers (seed URL)                  |
|  09:55:55  Found 12 links on /Support/Printers                    |
|  09:56:01  Visiting /Support/Printers/All-In-Ones                 |
|  ----------------------------------------------------------------|
|  v [folder] Support                                               |
|      v [folder] Printers                                          |
|          v [folder] All-In-Ones                                   |
|              > [folder] ET Series                                 |
|              > [folder] WorkForce Series                          |
|              > [folder] Expression Series                         |
|          > [folder] Single Function                               |
|          > [folder] Wide Format                                   |
|      > [folder] Scanners                                          |
|      > [folder] Projectors                                        |
|  ----------------------------------------------------------------|
|  127 pages found -- Discovery is active                           |
+------------------------------------------------------------------+
```

### Live Mode Behaviors

1. **Tree is read-only.** No checkboxes. No explore buttons. The user is watching, not selecting.
2. **New nodes animate in.** When a new node appears, it fades in with a subtle highlight that dissipates after 2 seconds. This shows the tree growing in real time.
3. **Activity log sits above the tree.** Shows the 5 most recent activities. Scrollable to see history. Uses human-readable messages, not technical ones:
   - Good: "Found 12 links on /Support/Printers"
   - Bad: "Phase 1b: HTTP GET 200 /Support/Printers, extracted 12 hrefs, 8 same-domain"
4. **Progress bar** shows estimated completion. Phases are not named (Phase 0, Phase 1, etc.) -- instead: "Scanning navigation... Exploring links... Climbing to parent pages... Expanding branches..."
5. **Stop button** is prominent (destructive style). Label: "Stop and review results". Not just "Stop" -- the user needs to know stopping is safe and they keep their results.
6. **Auto-expand strategy:** Expand the first 2 levels by default. When a new child appears under a collapsed node, do NOT auto-expand (this would be disorienting on large sites). Instead, show a subtle count update on the collapsed parent: "Printers (+3)".

### Transition to Select Mode

When discovery completes (or user stops):

1. Activity log collapses into a summary line: "Discovery complete -- 484 pages found across 47 sections in 2m 14s"
2. Progress bar disappears
3. Guidance banner appears (see Part 6)
4. Checkboxes appear on explored nodes
5. Explore buttons appear on unexplored nodes
6. Tree auto-expands to show auto-matched/suggested nodes

---

## Part 5: Select Mode (After Discovery)

### Layout

```
+------------------------------------------------------------------+
|  Site Structure                           [Filter...          ]   |
|  484 pages across 47 sections                                     |
|  ----------------------------------------------------------------|
|  [!] We found content matching your samples in 3 sections.       |
|      They're pre-selected below. Review and adjust.              |
|  ----------------------------------------------------------------|
|  [Expand All]  [Collapse All]  |  [Select suggested]  [Clear]   |
|  ----------------------------------------------------------------|
|  v [folder] [x] Support                                          |
|      v [folder] [x] Printers                                     |
|          v [folder] [x] All-In-Ones                               |
|              v [folder] [x] ET Series            37 pages         |
|                  [file] [x] Epson ET-2850        12 pages         |
|                  [file] [x] Epson ET-4850        14 pages         |
|                  [file] [x] Epson ET-2800        11 pages         |
|                  [file] [ ] Epson ET-16650       Suggested         |
|              v [folder] [x] WorkForce Series     18 pages         |
|                  [file] [x] WorkForce WF-2960     9 pages         |
|                  [file] [ ] WorkForce WF-7840    Suggested         |
|                  [file] [ ] WorkForce WF-3823    Suggested         |
|              > [folder] [ ] Expression Series    [Explore]        |
|          > [folder] [ ] Single Function          [Explore]        |
|          > [folder] [ ] Wide Format              [Explore]        |
|      > [folder] [ ] Scanners                     [Explore]        |
|      > [folder] [ ] Projectors                   [Explore]        |
|  ----------------------------------------------------------------|
|  > Other Pages (12 items)                                         |
|  ----------------------------------------------------------------|
|  12 sections selected -- 89 pages                                 |
|                                    [Continue to configuration ->] |
+------------------------------------------------------------------+
```

### Selection Mechanics

**Checkbox cascade rules:**

- Checking a folder checks all its explored children (recursively).
- Unchecking a folder unchecks all its children.
- If some children are checked and some are not, the folder shows an indeterminate state (dash icon instead of check).
- Unexplored nodes cannot be checked (they have no page count -- there's nothing to crawl yet). The checkbox is replaced by the Explore button.
- Checking a "Suggested" node auto-triggers exploration if it hasn't been explored yet.

**"Select suggested" button:**

- Selects all nodes the system identified as matching the user's sample URLs.
- This is the one-click happy path: "Trust the system's recommendations."
- Shows a preview before applying: "Select 8 sections (estimated 134 pages)?"

### Right-Click Context Menu

Adds discoverability for power-user actions:

```
+---------------------------+
| Explore this section      |
| Select this branch        |
| Deselect this branch      |
| ----------------------    |
| Open URL in new tab       |
| Copy URL                  |
| ----------------------    |
| Show details              |
+---------------------------+
```

"Show details" opens a side panel (see Part 7).

### Footer Bar

The footer is a sticky action bar at the bottom of the tree:

```
12 sections selected -- 89 pages              [Continue to configuration ->]
```

- **Left side**: Selection summary. Updates live as user checks/unchecks.
- **Right side**: Primary action button. Disabled when 0 sections selected. Label includes the count for confidence: "Continue with 12 sections".
- If no sections are selected, the left side shows: "No sections selected. Check the boxes next to the content you want to crawl."

---

## Part 6: User Guidance and Onboarding

### First-Time Guidance Banner

Appears between the header and the tree on first visit (dismissible, remembered in localStorage):

```
+------------------------------------------------------------------+
| [lightbulb icon]                                                  |
| This is your site's structure. Check the sections you want to     |
| crawl. We've suggested sections matching your sample URLs.        |
|                                                                   |
| [Select suggested sections]          [I'll pick manually]  [x]   |
+------------------------------------------------------------------+
```

Two clear paths:

1. **"Select suggested sections"** -- one click, trust the system, move forward.
2. **"I'll pick manually"** -- dismisses the banner, user browses the tree.

### Post-Discovery Summary

When transitioning from live to select mode, show a brief summary:

```
Discovery complete in 2m 14s
-- 484 pages found across 47 sections
-- 3 sections match your sample URLs (pre-selected)
-- 12 sections have unexplored content (click Explore to see more)
```

### Empty State (Discovery Found Nothing)

If discovery returns 0 or very few nodes:

```
+------------------------------------------------------------------+
| [warning icon]                                                    |
| We couldn't find much content on this site.                       |
|                                                                   |
| This might happen if:                                             |
| -- The site requires JavaScript to load (we'll try a browser)     |
| -- The site blocks automated access                               |
| -- The URL doesn't have linked content                            |
|                                                                   |
| [Try with browser rendering]    [Add URLs manually]    [Back]    |
+------------------------------------------------------------------+
```

### Tooltip Strategy

- **Node label**: Hover shows the full URL. This is the primary verification mechanism.
- **Page count badge**: Hover shows "37 pages found under this section. Select to include in crawl."
- **Suggested label**: Hover shows "This section matches your sample URL pattern: /Support/Printers/All-In-Ones/\*"
- **Explore button**: Hover shows "Visit this URL and discover pages underneath it."
- **Error text**: Hover shows the full error message (e.g., "HTTP 403 Forbidden -- this page blocks automated access").

---

## Part 7: Detail Panel (On Demand)

For users who want more information about a node, a slide-out panel appears on right-click > "Show details" or a keyboard shortcut (Ctrl+I / Cmd+I).

```
+-----------------------------------+
| Epson ET-2850                     |
| /Support/Printers/.../ET-2850     |
| --------------------------------- |
| Status: Explored (12 pages)       |
| Discovered via: Navigation scan   |
| Rendering: HTTP (no JS needed)    |
| --------------------------------- |
| How it was found:                 |
|   Linked from:                    |
|   -- /Support/Printers/All-In-Ones|
|   -- /Support/Printers (sitemap)  |
|   First seen: 09:55:53            |
| --------------------------------- |
| Pages (12):                       |
|   Epson ET-2850 Overview     [->] |
|   Epson ET-2850 FAQs        [->] |
|   Epson ET-2850 Downloads    [->] |
|   ...                             |
+-----------------------------------+
```

This panel is where ALL the developer information goes. Rendering method, discovery source, link frequency, page role, foundOn list -- all available here for users who want to investigate. But it never pollutes the tree rows.

---

## Part 8: Search and Filter

### Search Bar

Located in the tree header. Filters the tree in real time as the user types.

- Matches against node labels (not URLs by default).
- Toggle: "Search by URL" to match against URLs instead.
- When filtering is active, the tree auto-expands all matching branches and collapses non-matching ones.
- Parent chain is preserved: if a child matches, all its ancestors are shown (but non-matching siblings are hidden).
- Clear button (X) resets the filter and restores previous expand/collapse state.

### Quick Filters

Pill buttons above the tree (select mode only):

```
[All]  [Selected]  [Suggested]  [Unexplored]  [Errors]
```

- **All**: Default. Shows everything.
- **Selected**: Shows only checked nodes and their parent chains. Useful for reviewing before proceeding.
- **Suggested**: Shows only auto-matched nodes. Useful for reviewing the system's recommendations.
- **Unexplored**: Shows only nodes that haven't been explored yet. Useful for finding what to explore next.
- **Errors**: Shows only failed nodes. Useful for debugging.

Quick filters compose with the search bar: searching while "Selected" filter is active searches only within selected nodes.

---

## Part 9: Scale Handling (50k+ Nodes)

### Virtualization

The tree uses `@tanstack/react-virtual` (already implemented). Key behaviors at scale:

- Only visible rows are rendered (overscan of 20 rows for smooth scrolling).
- Row height is fixed at 36px for consistent virtualization.
- Max visible height: 520px, then scroll.

### Collapse Strategy for Large Trees

When a tree has more than 200 root-level nodes:

1. **Auto-collapse to depth 1.** Only top-level categories visible initially.
2. **Show count on collapsed nodes**: "Printers (47 sections inside)"
3. **"Jump to" search** becomes the primary navigation method -- browsing 200+ collapsed folders is impractical.

When a tree has more than 1000 total nodes:

1. Everything above, plus:
2. **Folder-level selection only.** Individual page checkboxes hidden by default. Toggle: "Show individual pages" for users who need page-level control.
3. **Aggregated page counts** on folders: "Printers -- 1,247 pages" to give a sense of scale.
4. **Warning banner**: "This is a large site. We recommend selecting top-level sections rather than individual pages."

### Performance Guards

- Search debounce: 200ms delay before filtering (prevents lag on every keystroke).
- Flatten memoization: The `flattenVisibleTree` function is memoized on `[tree, collapsedIds]`.
- Expand All disabled above 5000 nodes (would render all 5000 rows, defeating virtualization).
- Page lists under nodes lazy-load: clicking an explored node's page count opens the detail panel rather than inline-expanding 200 page URLs.

---

## Part 10: View Mode Toggle

### Three Views (Existing, Simplified Labels)

The header offers three view toggles, but with user-friendly names:

| Internal Name | User-Facing Label   | Description                                                                    |
| ------------- | ------------------- | ------------------------------------------------------------------------------ |
| `hybrid`      | **Smart** (default) | Groups by content relationships (breadcrumbs, linking patterns, URL structure) |
| `crawl-path`  | **As Discovered**   | Groups by how the crawler found each page. Shows the actual crawl path.        |
| `url-path`    | **By URL**          | Groups strictly by URL path segments. Most predictable, least intelligent.     |

```
  View: [Smart]  [As Discovered]  [By URL]
```

The "Smart" view is the default because it produces the most intuitive hierarchy for most sites. "By URL" is the fallback when the smart grouping produces unexpected results. "As Discovered" is for power users who want to understand the crawl path.

### Add from Sitemap

Remains in the header as a separate action button: `[+ Add from Sitemap]`. Only visible when a sitemap was detected for the domain. Opens a confirmation dialog with a preview of what will be added.

---

## Part 11: Component Specifications

### UnifiedTreeNodeRow (Redesigned)

```
Props:
  node: UnifiedTreeNode
  depth: number
  isCollapsed: boolean
  mode: 'live' | 'select'
  onToggleCollapse: (nodeId: string) => void
  onToggleIncluded: (nodeId: string) => void
  onExploreNode: (nodeId: string) => void
  onShowDetails: (nodeId: string) => void

Visual structure:
  padding-left: depth * 20 + 8px

  [Chevron 20x20]     -- ChevronRight (collapsed) / ChevronDown (expanded) / empty (leaf)
  [Icon 16x16]        -- Folder / FolderOpen / FileText / Loader2 (exploring)
  [Checkbox 16x16]    -- Only in select mode, only for explored/auto-matched nodes
  [Label flex-1]      -- text-sm, truncate, tooltip={node.url || node.label}
  [Status area]       -- Right-aligned, one of:
                          PageCount: text-xs text-foreground-meta "{N} pages"
                          Suggested: text-xs text-accent-muted "Suggested"
                          Explore:   Button ghost size=xs "Explore"
                          Exploring: Loader2 spin + text-xs "Exploring..."
                          Error:     text-xs text-error "Could not reach" + Retry link

Background:
  Default: transparent
  Hover: bg-background-muted/60
  Selected (included): bg-accent-subtle/20
  Error: bg-error/5
  Exploring: bg-info/5
```

### UnifiedTreeHeader (Redesigned)

```
Row 1: Title + Search
  Left:  "Site Structure" (h3) + node count in parentheses (not a badge)
  Right: Search input with icon

Row 2: Quick filters (select mode only)
  [All] [Selected] [Suggested] [Unexplored] [Errors]

Row 3: Actions + View toggle
  Left:  [Expand All] [Collapse All] | [Select suggested] [Clear all]
  Right: View: [Smart] [As Discovered] [By URL]  |  [+ Add from Sitemap]
```

### GuidanceBanner

```
Props:
  onSelectSuggested: () => void
  onDismiss: () => void
  suggestedCount: number
  estimatedPages: number

Renders:
  bg-info/10 border border-info/20 rounded-lg px-4 py-3
  Icon: Lightbulb (text-info)
  Text: "This is your site's structure. Check the sections you want to crawl.
         We've suggested {N} sections matching your sample URLs (~{M} pages)."
  Actions: [Select suggested sections] (primary)  [I'll pick manually] (ghost)  [x] (dismiss)
```

### NodeDetailPanel

```
Props:
  node: UnifiedTreeNode
  onClose: () => void
  onExplore: (nodeId: string) => void

Renders as right-aligned slide-out panel (320px wide):
  Section 1: Identity
    - Label (h4)
    - Full URL (monospace, clickable)
    - Status badge

  Section 2: Discovery Details (all the developer info lives here)
    - Discovered via: {source in human terms}
    - Rendering method: HTTP / Browser
    - Page role: Hub / Page / Mixed
    - Link frequency: Found on {N} pages
    - First discovered: {timestamp}
    - Global link: Yes/No

  Section 3: Linked From
    - List of foundOn URLs (clickable, navigate to that node in tree)

  Section 4: Pages (if explored)
    - Scrollable list of pages with titles
    - Each page clickable (opens in new tab)
```

---

## Part 12: Interaction Patterns Summary

### Explore Pattern

```
User sees unexplored node with [Explore] button
  -> Clicks Explore
  -> Button becomes spinner + "Exploring..."
  -> Node icon changes to spinner
  -> After 2-10 seconds:
     SUCCESS:
       -> Spinner stops
       -> Icon returns to folder/file
       -> Page count appears: "14 pages"
       -> Checkbox appears
       -> Children nodes animate in (if any discovered)
       -> Node is auto-selected (checkbox checked)
     FAILURE:
       -> Spinner stops
       -> "Could not reach" + [Retry] appears
       -> Node stays unselectable
       -> Tooltip shows full error
```

### Select Pattern

```
User checks a folder node
  -> All explored children become checked
  -> Unexplored children stay unchecked (nothing to crawl)
  -> Footer updates: "14 sections selected -- 237 pages"

User checks an individual page
  -> Just that page is checked
  -> Parent folder shows indeterminate state if siblings are mixed
  -> Footer updates

User clicks "Select suggested"
  -> All auto-matched nodes become checked
  -> Their explored parent folders become checked
  -> Banner: "Selected 8 sections (134 pages)"
```

### Filter Pattern

```
User types "printer" in search
  -> 200ms debounce
  -> Tree filters to show only nodes with "printer" in label
  -> All ancestor nodes of matches are shown (preserving hierarchy)
  -> Non-matching siblings hidden
  -> Match text highlighted in node labels
  -> Footer shows: "Showing 23 of 484 nodes"

User clicks X to clear search
  -> Full tree restored
  -> Previous expand/collapse state restored
```

---

## Part 13: Terminology Map

Replace developer terms with user terms throughout the UI:

| Developer Term        | User-Facing Term                                                  |
| --------------------- | ----------------------------------------------------------------- |
| Node                  | Section (for folders) / Page (for leaves)                         |
| Explore               | Explore                                                           |
| Auto-matched          | Suggested                                                         |
| Included              | Selected                                                          |
| Tree                  | Site structure                                                    |
| Discovery             | Finding content / Scanning the site                               |
| BFS                   | (never shown)                                                     |
| Nav extraction        | Scanning navigation                                               |
| Breadcrumb climb      | Exploring parent pages                                            |
| Depth probing         | Expanding branches                                                |
| Render method         | (never shown in tree; "HTTP" and "Browser" only in detail panel)  |
| Virtual folder        | (just show as folder with folder icon; no label)                  |
| Global link           | Site-wide link                                                    |
| foundOn               | Linked from                                                       |
| Page role             | (never shown in tree; only in detail panel as Hub/Page/Mixed)     |
| Link frequency        | (never shown in tree; only in detail panel as "Found on N pages") |
| Seed URL / Sample URL | Sample URL (consistent)                                           |

---

## Part 14: State Transitions

```
                    Discovery starts
                          |
                    +-----v-----+
                    | LIVE MODE |  -- Tree growing, read-only
                    +-----+-----+
                          |
              Discovery completes / user stops
                          |
                    +-----v-----+
                    |  GUIDANCE  |  -- Banner with "Select suggested" or "Pick manually"
                    +-----+-----+
                          |
                User chooses path
                          |
                    +-----v------+
                    | SELECT MODE |  -- Checkboxes, explore buttons, filters
                    +-----+------+
                          |
                User clicks "Continue"
                          |
                    +-----v------+
                    |  CONFIGURE  |  -- Existing Step 3 (crawl settings)
                    +------+-----+
```

---

## Part 15: Accessibility

- **ARIA tree role**: The tree container has `role="tree"`, each row has `role="treeitem"`.
- **aria-expanded**: Set on collapsible nodes.
- **aria-selected**: Set on checked nodes (select mode).
- **aria-level**: Set to depth + 1 on each row.
- **Focus management**: Arrow keys navigate rows. Enter expands/collapses or triggers Explore. Space toggles checkbox.
- **Screen reader announcements**: When a node finishes exploring, announce "Exploration complete. 14 pages found under ET Series."
- **Color independence**: All states distinguishable without color (explored = page count text, error = "Could not reach" text, exploring = spinner animation).
- **Minimum touch target**: All interactive elements are at least 32x32px.

---

## Part 16: Migration from Current Implementation

### Files to Modify

| File                     | Changes                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `UnifiedTreeNodeRow.tsx` | Remove 8 badge types. Add persistent Explore button. Restructure status area.                     |
| `UnifiedTreeHeader.tsx`  | Remove "nodes" badge. Add quick filter pills. Rename view toggles. Restructure action row.        |
| `UnifiedTree.tsx`        | Add guidance banner. Add "Other Pages" group logic. Add detail panel trigger. Update footer copy. |
| `unified-tree-types.ts`  | No changes (data model stays the same; we just stop rendering most fields).                       |
| `tree-merge.ts`          | Add `isOrphan` computation for "Other Pages" grouping.                                            |

### New Files

| File                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `GuidanceBanner.tsx`  | First-time guidance with "Select suggested" / "Pick manually" |
| `NodeDetailPanel.tsx` | Slide-out panel with all developer info                       |
| `QuickFilters.tsx`    | Filter pill bar component                                     |

### Data Model Impact

**Zero breaking changes.** The `UnifiedTreeNode` type keeps all fields. We simply stop rendering most of them in the tree row and move them to the detail panel. This means:

- No backend changes required.
- No API changes required.
- No data migration required.
- All fields remain available for the detail panel and for future features.

---

## Appendix A: Comparison with Current UI

| Aspect                  | Current                            | Proposed                                    |
| ----------------------- | ---------------------------------- | ------------------------------------------- |
| Elements per row        | Up to 10 (badges, dots, icons)     | Maximum 6                                   |
| Explore discoverability | Hover-only compass icon            | Always-visible "Explore" button             |
| Orphan nodes            | Flat root-level items              | "Other Pages" collector group               |
| Global nav links        | Inline with content, dimmed        | Hidden by default, toggleable               |
| User guidance           | None                               | Guidance banner with two paths              |
| Developer info          | Inline badges on every row         | On-demand detail panel                      |
| Post-discovery action   | "Select All" / "Deselect All" only | "Select suggested" with preview             |
| Status vocabulary       | HTTP, BFS, Nav, Global, leaf, hub  | Explored, Suggested, Explore                |
| Error recovery          | Red text + Retry button            | "Could not reach" + Retry link with tooltip |
| Search                  | Label-only filter                  | Label + URL toggle, with quick filter pills |

## Appendix B: Open Questions

1. **Should "Select suggested" auto-trigger exploration?** If a suggested node hasn't been explored yet, selecting it could queue exploration automatically. Pro: one-click path works end-to-end. Con: exploration takes time, user might not expect network activity from checking a box. **Recommendation**: Yes, auto-trigger. Show a brief toast: "Exploring 3 suggested sections..."

2. **Should the tree show page count estimates before exploration?** We could show "~47 pages" based on sitemap data or link analysis before actually exploring. Pro: helps users prioritize what to explore. Con: estimates can be very wrong. **Recommendation**: Only show estimates from sitemap data (which is reliable). BFS-discovered nodes show count only after exploration.

3. **Should the detail panel auto-open on first explore?** When a user explores their first node, auto-opening the detail panel would teach them it exists. Pro: discoverability. Con: might feel intrusive. **Recommendation**: Auto-open once (first exploration only), then user controls it.
