# 04 — AI Helper

**Implements BRD §8.2, §9.3 (FR-HLP-01 through FR-HLP-17), and refines per the proposed §9.3.1 Platform Q&A expansion (note: §9.3.1 was drafted in conversation but not yet inserted into the BRD; the prototype still demonstrates that scope).**

The AI Helper is a floating button visible on every authenticated route, and a chat-style panel that opens from it. The Helper is the product's defining UX commitment to non-technical users.

## Floating Helper button (FAB)

- **Position:** fixed bottom-right, 24px from both edges. Z-index above content but below modals.
- **Size:** 48px circle.
- **Visual:** purple-tinted background (`bg-purple/15`), purple Lucide `Sparkles` icon. Subtle pulse animation when idle, more pronounced when the Helper has a new suggestion (e.g., post-evaluation).
- **Tooltip on hover:** *"AI Helper · ⌘/"*
- **Keyboard shortcut:** `⌘/` (Cmd+Slash) toggles open/close.
- **Notification dot:** small purple dot top-right of the FAB when the Helper has a contextual suggestion (e.g., after evaluation re-run, after auto-generation, after a Blocker flag is detected).

## Helper sheet (panel)

- **Trigger:** clicking FAB, pressing ⌘/, or any "Ask Helper / Discuss with Helper" link elsewhere in the app.
- **Style:** slides in from the right. 480px wide. Full viewport height. `bg-background-elevated` with left border (`border-l border-border`). Backdrop click closes.
- **Header:**
  - Top-left: small `Sparkles` icon + "AI Helper" title
  - Below title: a small breadcrumb showing the active context (e.g., *"Review Studio · card-dispute-triage · Knowledge tab"*). When opened from the Helper FAB without specific context, breadcrumb reads *"General"*.
  - Top-right: kebab menu (DropdownMenu) with: "Clear conversation," "Open in new window" (decorative), "Send feedback on this answer" — and a close X.
- **Body:** chat-style conversation. See structure below.
- **Footer:** input row.

## Conversation structure

Each conversation has a series of `HelperTurn` items from `helper.ts`. Turn rendering:

### Helper turn

- Avatar: small purple `Sparkles` chip
- Bubble: `bg-background-muted`, soft, max-width ~90% of sheet width
- Text: Geist Sans, regular weight
- **Inline citation** (when present): superscript number that, when hovered, shows a tooltip with the cited source. Clicking the number opens a Sheet-in-Sheet ("Inline reference" Sheet) with the full passage and a link to the source.
- **Suggested action** (when present): below the bubble, a small action card:
  - Label (e.g., *"Add this guardrail to your app"*)
  - Preview (e.g., the proposed text)
  - Two buttons: **Confirm** (primary, monochrome) · **Skip** (subtle)
  - On Confirm: a success toast + the action visually applies elsewhere (decorative for prototype).

### User turn

- No avatar (left-aligned by default in this single-column chat layout to keep things simple); or right-aligned with a small initials chip.
- Bubble: `bg-background-elevated`, `text-foreground`, slightly tighter padding.

### System note

For events like "Action confirmed," "Conversation cleared," etc. — a thin centered line in `text-foreground-subtle text-xs`.

## Initial / empty state

When the user opens the Helper for the first time (no conversation yet for this context):

- A small welcome message from the Helper:
  > *"Hi Nilotpal — I'm your AI Helper. I can explain what the platform built from your SOP, suggest edits, walk you through evaluations, answer product questions, and act on your behalf with your confirmation. What do you want to do?"*
- Below the message, four **suggestion chips** that change based on the active context:

| Context | Suggestion chips |
|---|---|
| General | *"Show me my apps' health"* · *"What's a sub-agent?"* · *"Explain my evaluation report"* · *"How do I deploy?"* |
| Review Studio | *"Walk me through this app"* · *"Why did you attach these knowledge sources?"* · *"How do I add a custom guardrail?"* · *"Suggest one improvement"* |
| SOP auto-gen result | *"Explain how my SOP maps to this app"* · *"Why did you pick these sub-agents?"* · *"What does each flag mean?"* · *"What's missing?"* |
| Evaluation Report | *"Explain my score"* · *"Which categories should I improve?"* · *"Show me the worst failing case"* · *"Suggest a fix for the lowest category"* |
| Mission Control | *"Are any apps drifting?"* · *"Why was this app rate-limited?"* · *"Show me the audit trail for app X"* |

Clicking any chip submits it as a user message and renders a pre-scripted Helper response (from `helper.ts`).

## Footer input

- Multi-line autosize textarea (max 6 lines), placeholder *"Ask me anything about the platform or your apps…"*
- Send button (Lucide `ArrowUp` in a circular tile)
- Hint row beneath input:
  - Left: *"⏎ Send · Shift+⏎ New line"*
  - Right: a small "Helper memory: this conversation only" pill (decorative — clicking opens a small Popover explaining retention rules per FR-HLP-15)

## Context anchoring (FR-HLP-02)

When the user opens the Helper from a specific UI affordance (e.g., a panel's "Discuss with Helper" link), the Helper sheet:
- Sets its breadcrumb to that context
- Pre-fills a relevant first prompt
- Surfaces context-specific suggestion chips
- Shows a thin "Context" card under the welcome message, with the relevant entity rendered (e.g., the specific Blocker flag, or the specific evaluation category) and a small *"Helper has read this context"* note.

## Scripted conversation examples (from `helper.ts`)

For the prototype, include 2–3 scripted conversations per context. Examples:

**Context: Review Studio · Knowledge tab · "Why did you attach these knowledge sources?"**
1. User: *"Why did you attach these knowledge sources?"*
2. Helper: *"I attached 4 sources for `card-dispute-triage`. Here's why each one mapped to your SOP:*  
   - *Reg E playbook¹ — your SOP mentions Reg E disclosures in §3 and §7.*  
   - *Card dispute disclosures² — your SOP requires consumer notice within 10 business days.*  
   - *Member identity policy³ — you require multi-factor before processing disputes.*  
   - *Cornerstone FAQ⁴ — from your Knowledge Library, contains your specific dispute timeline."*  
3. *(Helper offers suggestion card: "Want me to add the FFIEC fraud guidance? It's in your Knowledge Library but not currently attached." with [Confirm] / [Skip])*

**Context: Evaluation Report · "Suggest a fix for the lowest category"**
1. User: *"Suggest a fix for the lowest category"*
2. Helper: *"Your lowest category is Hardship eligibility logic at 78%. The most common failure pattern: the app accepted hardship requests without the required income-loss documentation step (your SOP §4 calls for this).*  
   *Two options:*  
   *1) Add a guardrail: 'Require income-loss documentation before drafting payment plan.'*  
   *2) Update the Account Services sub-agent's task spec to require the doc step.*  
   *Want me to apply option 1?"*
3. *(Suggestion card with the proposed guardrail text and [Confirm] / [Skip])*

## Click model

| Element | Action |
|---|---|
| FAB | Opens/closes the sheet |
| ⌘/ shortcut | Same as FAB click |
| Suggestion chip | Submits as user message, scripted Helper reply renders |
| Citation number | Tooltip on hover; Sheet-in-Sheet on click |
| Suggestion-action **Confirm** | Toast confirmation + decorative "applied" state |
| Suggestion-action **Skip** | Card collapses |
| Kebab → "Clear conversation" | Resets to welcome state |
| Kebab → "Send feedback" | Opens a small Dialog with thumbs-up/down + comment field |
| Send button | Adds user message to conversation; renders scripted reply if matched, else renders a *"I'd answer this in a real Helper. For the prototype, try one of the suggestions above."* fallback |

## States to render

- **Welcome / empty** — no prior conversation, suggestion chips visible
- **Active conversation** — user + helper turns rendered
- **Helper has unread suggestion** — FAB shows the notification dot
- **Context-anchored open** — breadcrumb reflects context, first prompt pre-filled

## Out of scope

- Real LLM streaming responses (typing animation OK; backing LLM not real)
- Real follow-up coherence (scripted replies only)
- Multi-window or pop-out (kebab option is decorative)
- Feedback submission backend (dialog closes without persisting)

## Acceptance criteria

- FAB renders on every authenticated route.
- Sheet opens/closes via FAB click and ⌘/ shortcut.
- Context labels reflect where the Helper was opened from.
- All scripted conversations play through without errors.
- Suggestion cards' Confirm/Skip update local state visibly.
- Closing the sheet preserves the conversation if reopened in the same context within the session.
