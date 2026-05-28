# Visual Prototype PRD — Overview

## Purpose

Produce a clicky, dark-themed Next.js visual prototype of the credit-union Agentic AI Platform described in `BRD_Agentic_AI_Platform.md`. The prototype is a **demo-grade UI** intended for stakeholder walkthroughs, CXO sharing, and design validation. It is **not** a production platform.

- ✅ Looks like the product. Every key BRD concept is rendered.
- ✅ Clicks navigate between screens; mock data populates everything.
- ✅ Animations and loading states are simulated for storytelling.
- ❌ No real backend. No real LLM calls. No real auth. No real integrations.
- ❌ No data persistence beyond in-memory React state.

## Audience for the prototype

- CXOs reviewing the product vision (per `BRD_Executive_Summary.md`)
- Prospective customers walking through the product feel
- Designers iterating on layout and information hierarchy
- Stakeholders pressure-testing the BRD's claims

## Tech stack (pinned)

| Layer | Choice |
|---|---|
| Framework | Next.js 15.5.x (App Router, all client components) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS 3.4 with design tokens (already in `app/globals.css`) |
| Component primitives | `@radix-ui/react-*` (Dialog, DropdownMenu, Popover, Tabs, Tooltip, Select, RadioGroup, Switch) — install only when first used |
| Icons | `lucide-react` |
| Charts | `recharts` v2 |
| Class utility | `clsx` + `tailwind-merge` (helper at `lib/utils.ts`) |
| Mock state | Local React state + `zustand` (install only when global state is needed) |
| Font | Geist Sans + Geist Mono (already wired via `geist` package) |

Do not introduce additional libraries without an explicit reason. No state management library beyond Zustand. No backend, no database, no API routes.

## Design tokens (already established)

Defined in `app/globals.css` (mirrored from `apps/studio/src/app/globals.css` in the original ABL repo). Key palette:

| Token | Value |
|---|---|
| `--background` | `220 3% 4%` (near-black) |
| `--background-subtle` | `220 3% 7%` (panels) |
| `--background-muted` | `220 3% 10%` (cards) |
| `--background-elevated` | `220 3% 12.5%` (popovers, modals) |
| `--foreground` | `220 1% 98%` (primary text) |
| `--foreground-muted` | `220 2% 64%` (secondary text) |
| `--foreground-meta` | `220 2% 55%` (timestamps, captions) |
| `--foreground-subtle` | `220 2% 45%` (tertiary text) |
| `--border` | `220 4% 18%` |
| `--border-muted` | `220 2% 14%` |
| `--accent` | `220 5% 93%` (monochrome accent) |
| `--accent-foreground` | `220 5% 5%` |
| `--success` | `142.1 76.2% 36.3%` |
| `--warning` | `40 93.4% 47.5%` |
| `--error` | `0 72.2% 50.6%` |
| `--info` | `187.2 85.7% 53.3%` |
| `--purple` | `262.1 83.3% 57.8%` (AI / LLM accent) |

Use these via Tailwind class names (`bg-background`, `text-foreground-muted`, `border-border-muted`, `text-purple`, etc. — already wired in `tailwind.config.ts`).

**Visual identity rules:**
- Dark theme, always (no light-mode toggle in prototype).
- Monochrome accent for primary actions (white/light-gray on dark).
- Purple reserved for AI / LLM / Helper surfaces.
- Status colors used semantically only (success for "approved/deployed/passing," warning for "paused/needs attention," error for "failed/blocker," info for "informational/in-progress").
- Typography: Geist Sans body, Geist Mono for IDs, timestamps, metric values, agent/app names.
- Border radius: 4–8px (sm/md/lg). No huge rounded corners.
- Spacing: 4px base unit. Tailwind defaults align.
- Animation: subtle, spring-eased. Existing `animate-fade-in` and `animate-shimmer` in `tailwind.config.ts`.

## Persona contexts to render

The prototype assumes the user is signed in. Persona switching is via a header toggle (mock — switches identity context only):

1. **Process Owner** — *default persona*. Sees: dashboard, Apps, SOPs, Helper, Review Studio, Evaluations, Marketplace.
2. **Compliance Reviewer** — sees: review queue, approval detail, audit log. Does NOT see authoring screens.
3. **CU Admin** — sees: Knowledge Library, Model Integration settings, user/role management, tenant settings, Mission Control.

Default mock organization: **"Cornerstone Federal Credit Union"** (mock CU partner).

## File / folder structure (target)

```
/
├── app/
│   ├── (process-owner)/
│   │   ├── page.tsx                    Dashboard (already exists, replaces current placeholder)
│   │   ├── sops/
│   │   │   ├── page.tsx                SOP list
│   │   │   ├── new/page.tsx            SOP upload flow
│   │   │   └── [sopId]/page.tsx        SOP detail + auto-gen result
│   │   ├── apps/
│   │   │   ├── page.tsx                Apps list
│   │   │   └── [appId]/
│   │   │       ├── page.tsx            Review Studio (default tab)
│   │   │       ├── evaluation/page.tsx Evaluation Report
│   │   │       └── deploy/page.tsx     Deployment confirmation
│   │   └── marketplace/page.tsx
│   ├── (reviewer)/
│   │   ├── queue/page.tsx              Reviewer queue
│   │   └── queue/[appId]/page.tsx      Reviewer detail / approval
│   ├── (admin)/
│   │   ├── mission-control/page.tsx
│   │   ├── audit/page.tsx
│   │   ├── knowledge/page.tsx
│   │   ├── knowledge/[sourceId]/page.tsx
│   │   ├── models/page.tsx
│   │   └── settings/page.tsx
│   ├── layout.tsx                      Root layout (already exists)
│   ├── globals.css                     Design tokens (already exists)
│   └── page.tsx                        Default redirect → /(process-owner)
├── components/
│   ├── shell/                          AppShell, Topbar, Sidebar, PersonaSwitcher
│   ├── helper/                         FloatingHelperButton, HelperSheet, HelperConversation
│   ├── review-studio/                  Studio panels (one file per panel)
│   ├── evaluation/                     EvaluationReport, ScoreCard, CategoryDrilldown
│   ├── mission-control/                LiveOps, ContinuousEval, KillSwitchPanel
│   ├── knowledge/                      KnowledgeLibraryTable, SourceCard, IngestionDialog
│   ├── models/                         ModelEndpointCard, AddEndpointDialog, RoutingMatrix
│   └── ui/                             Shared low-level (Button, Card, Input, Select, Tabs, etc.)
├── lib/
│   ├── mock-data/                      One file per domain (apps.ts, sops.ts, evaluations.ts, etc.)
│   ├── persona.ts                      Persona switching (in-memory)
│   └── utils.ts                        cn() etc. (already exists)
└── docs/prd/                           This PRD
```

## Build phasing (one capability per session)

Recommended order to keep each session shippable and reviewable:

1. **App shell** — Topbar with persona switcher, sidebar nav, layout, footer. Replaces the existing minimal shell.
2. **Process Owner dashboard** — refresh the existing dashboard to match the BRD vocabulary (Apps, SOPs, AI Helper, Mission Control nav). Reuses existing components.
3. **SOP-to-app flow** — SOP upload → parsing animation → reveal of auto-generated app.
4. **Review Studio** — the largest single screen; build panel-by-panel.
5. **AI Helper** — floating button + chat sheet, accessible globally.
6. **Evaluation Report** — score-based, drill-down to failing cases.
7. **Approval + Deployment** — submit flow → reviewer queue → reviewer detail → deploy.
8. **Mission Control + Audit** — live ops, continuous eval, audit log.
9. **Knowledge Library + Model Integration** — CU Admin settings surfaces.
10. **Marketplace** — curated browse.

Each session has its own PRD file (01–11) with screen-level detail.

## BRD traceability

Every capability file lists the BRD sections it implements visually. Use that to validate completeness when the prototype is done.

## Out of scope for the prototype

| What | Why |
|---|---|
| Real auth | Persona switching is a header toggle |
| Real file upload | "Upload SOP" simulates a 3-second parse then jumps to the reveal screen |
| Real LLM calls | All Helper conversations are pre-scripted mock turns |
| Real evaluation runs | Score numbers are hardcoded; "Re-run evaluation" triggers a fake loader |
| Real connectors | Knowledge Sources and Model Endpoints are static cards with status |
| Real form validation logic | Forms accept anything visually but don't persist |
| Form persistence across navigation | OK to reset on route change |
| Light mode | Dark mode only |
| Mobile responsiveness | Desktop ≥ 1280px target only. Don't break on tablet but don't optimize. |
| i18n | English only |
| Accessibility beyond keyboard nav and ARIA basics | Don't bake screen-reader optimization in |
| Backend API | None. Mock data lives in `lib/mock-data/`. |
| Tests | Unit tests not required for the prototype. |
| Performance optimization | No virtualized lists, no code-splitting beyond Next.js defaults. |

## Acceptance criteria (per session)

Each session is "done" when:
- The target screen(s) render with the mock data shapes from `99-mock-data.md`.
- Navigation in/out of the screen works.
- The interactions listed in the PRD's "Click model" section behave as described.
- Visual fidelity matches the screen's layout sketch and design-token rules.
- No console errors. `pnpm build` (or `npm run build`) succeeds.

## How to use this PRD

For each capability file (01–11):
1. Read the file end-to-end.
2. Cross-reference any data shapes in `99-mock-data.md`.
3. Build the screen(s) per the layout + click model.
4. Validate against the acceptance criteria.
5. Commit (if approved) and move to the next.

If anything in the PRD is ambiguous, prefer the BRD's intent. If still ambiguous, raise a clarifying question rather than guess.
