# 02 — SOP-to-App Flow

**Implements BRD §9.1 SOP Intake, §9.2 Auto-Generation Engine, §9.4 SOP Quality Check.**

A three-step flow that turns an uploaded SOP into a working app draft:

1. **Upload SOP** screen (`/sops/new`)
2. **Parsing animation** (in-page state on `/sops/new`, no separate route)
3. **Auto-generation result** screen (`/sops/[sopId]` or routes forward to `/apps/[appId]`)

The Helper FAB is available throughout. The user can return to any SOP later from `/sops`.

## Screen 1: Upload SOP (`/sops/new`)

### Page header

- H1: *"Bring your SOP. We'll build the app."*
- Sub: *"Upload a Standard Operating Procedure. The platform reads it, applies credit-union expertise, and generates a working agentic app. The AI Helper walks you through every step."*

### Upload card (centered, max-width 720px)

A large dashed-border drop-zone card.

- Cloud-upload icon (Lucide `UploadCloud`, large)
- Headline: *"Drag your SOP here, or click to browse"*
- Sub: *"PDF, DOCX, TXT, MD, HTML, or paste text. Multiple files supported."*
- Pill row: supported formats as small chips: `PDF` `DOCX` `MD` `HTML` `TXT`
- Below the drop-zone, a small tab strip: **Upload** · **Paste text** · **From URL**. Default tab is Upload.

### "Paste text" tab

A textarea, 220px tall, placeholder *"Paste the SOP content here…"*. Below it, a small input for "Title" (defaults to "Untitled SOP"). Primary button: "Continue".

### "From URL" tab

A single URL input + "Continue" button. Helper-tip line: *"We'll fetch and parse the document. Authenticated URLs are not supported in the prototype."*

### Helpful side panel (right column, narrower)

A small bordered card titled *"Tips from the Helper"* (Lucide `Sparkles` icon + purple tint):
- *"A good SOP describes decision points, escalation rules, and disclosures."*
- *"Multi-file SOPs are supported — upload them together if they belong to one process."*
- *"We only flag safety and compliance issues. We don't suggest process changes."*

Below, *"Recent SOPs"* — a short list of the user's recently uploaded SOPs (top 3 from `sops.ts`). Each item:
- Filename, page count, parsed date.
- Clicking routes to that SOP's auto-gen result screen.

### Click model

| Element | Action |
|---|---|
| Drag-drop zone | Accepts a file visually but doesn't actually process it; goes straight to parsing state |
| Browse button | Opens native file picker; selecting any file goes to parsing state |
| Tab switcher | Switches between Upload / Paste / URL |
| "Continue" on Paste or URL tab | Goes to parsing state |
| Recent SOPs items | Routes to `/sops/[sopId]` |

## Screen 2: Parsing animation (in-page on `/sops/new`)

A full-page overlay replaces the upload card.

### Content

- Centered card, ~640px wide, `bg-background-elevated`, soft shadow.
- Large icon area (top): rotating Lucide `Loader2` (already used in the codebase), surrounded by a subtle pulsing glow.
- Headline cycles through messages on a 1.2s interval:
  1. *"Reading your SOP…"*
  2. *"Identifying intents, tasks, and escalation rules…"*
  3. *"Checking against the credit-union baseline for safety and compliance…"*
  4. *"Selecting sub-agents and attaching knowledge…"*
  5. *"Generating evaluation tests from your SOP…"*
- Below the headline, a thin progress bar fills slowly across ~6 seconds total.
- Footer text: *"You can continue working — we'll notify you when this is done."* + a small "Open Helper" link that opens the Helper panel.

After the progress completes, route forward to the auto-gen result screen for the new SOP. For the prototype, use a hardcoded `sopId` mapping (e.g., the file's first three letters → `sop_card_disputes` if PDF, else default to `sop_hardship`).

## Screen 3: Auto-generation result (`/sops/[sopId]`)

This is the "look at what we built" reveal screen. The user has not entered Review Studio yet; this is the *summary* of what was generated.

### Top section: SOP card

Two columns.

**Left (smaller, ~40% width):** The SOP's identity.
- Filename, page count, upload date, version, uploader avatar
- Stats row: *"9 intents · 12 tasks · 4 escalation rules · 14 pages"*
- Three flag badges: e.g., *"0 Blockers · 2 Warnings · 5 Suggestions"* with color-coded counts (Blocker=error, Warning=warning, Suggestion=info)
- Subtle "View SOP" link (decorative — could open a Sheet showing a stylized "PDF preview" of dummy content)

**Right (wider, ~60% width):** What we did.
- Headline: *"We generated `card-dispute-triage`."* (the auto-generated app name, from `apps.ts`)
- A short paragraph from `apps[].description`
- Primary CTA: **"Open Review Studio →"** (routes to `/apps/[appId]`)
- Secondary CTA: **"Show me how this maps to my SOP"** — opens the Helper panel anchored to "auto-generation explanation context"

### Middle section: What the platform attached (4-up grid)

Four cards summarizing the auto-generation output. Each card has an icon, a count, a 1-sentence description, and a list of items.

1. **Sub-agents · 3** — Lucide `Bot`
   - Member Authentication
   - Account Services
   - Compliance
   - *"Selected based on the intents and tasks the platform identified in your SOP."*
2. **Knowledge attached · 4** — Lucide `Database`
   - Reg E playbook
   - Card dispute disclosures
   - Member identity policy
   - Cornerstone FAQ (your KB)
   - *"Combines platform templates with sources from your Knowledge Library."*
3. **Guardrails applied · 7** — Lucide `Shield`
   - No PII echo
   - Failed-auth lockout
   - Mandatory disclosures
   - +4 more
   - *"Baseline credit-union guardrails plus SOP-derived custom rules."*
4. **Channels selected · 2** — Lucide `Send`
   - Digital
   - Voice
   - *"Inferred from the SOP. You can change these in Review Studio."*

### Lower section: SOP Quality Check results

A panel titled *"What we flagged in your SOP"* with a small note: *"We only flag safety and compliance issues. We never propose changes to process content."*

List of flag items (use mock data — e.g., 2 Warnings, 5 Suggestions, 0 Blockers). Each item:
- Severity icon + color
- Short title (e.g., *"Reg E timeline may exceed mandatory disclosure window"*)
- Quoted SOP passage (mono, indented, in `bg-background-muted` block)
- "Acknowledge" / "Discuss with Helper" buttons

If any Blockers exist, the "Open Review Studio" CTA above is **disabled** with a tooltip: *"Resolve or acknowledge all Blocker flags before opening Review Studio."*

### Helper nudge

Bottom of the page, a subtle inline Helper card:
> 💡 *"Want me to walk you through each section? I can explain why I attached Reg E and how the escalation rules I derived from your SOP map to actions."*  
> [Yes, walk me through it] [Not now]

Clicking "Yes" opens the Helper sheet with a pre-scripted onboarding flow.

## Click model

| Element | Action |
|---|---|
| "Open Review Studio →" | → `/apps/[appId]` |
| "View SOP" | Sheet/modal with dummy PDF preview (decorative) |
| "Show me how this maps to my SOP" | Opens Helper sheet, context = "auto-gen explanation" |
| Sub-agents / Knowledge / Guardrails / Channels cards | Static (or hover-only — list expands) |
| Flag "Acknowledge" | Marks flag as acknowledged (in local state only) |
| Flag "Discuss with Helper" | Opens Helper sheet anchored to this flag |
| "Yes, walk me through it" | Opens Helper sheet with onboarding script |

## States to render

- **Populated** (normal — the parse "succeeded")
- **Blocker present** — if mock data includes a Blocker flag, the "Open Review Studio" CTA is disabled and a banner appears above the SOP card: *"1 Blocker must be resolved before continuing."* (Use `sop_hardship` which has 1 Blocker.)

## Out of scope

- Real file parsing.
- Real LLM-driven auto-generation.
- SOP versioning UX (only show one version per SOP).
- Multi-file SOP UX beyond a visual hint that it's supported.

## Acceptance criteria

- Upload screen renders all three tabs with consistent layout.
- Parse animation plays through its sequence (~6 seconds) and routes forward.
- Auto-gen result screen renders all four "what we attached" cards with real mock data.
- Flag list renders flags with correct severity color coding.
- Blocker state correctly disables the "Open Review Studio" CTA.
- Helper nudge renders at bottom and opens the Helper sheet on confirm.
- All routes resolve without 404s.
