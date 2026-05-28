# 06 — Approval Workflow + Deployment

**Implements BRD §9.7 Approval Workflow, §9.8 Deployment.**

Three screens:

1. **Submit confirmation** (Sheet on top of Review Studio when Submit is clicked)
2. **Reviewer queue** (`/queue`)
3. **Reviewer detail / approval** (`/queue/[appId]`)
4. **Deploy confirmation** (`/apps/[appId]/deploy`)

## Screen 1: Submit confirmation (Sheet)

When the Process Owner clicks **Submit for approval** in Review Studio, a Sheet slides in from the right (or a centered Dialog — Sheet preferred for breathing room).

### Contents

- Title: *"Submit `card-dispute-triage` for approval"*
- Pre-flight summary (mirror of the Review Studio's bottom checklist):
  ```
  ✓ All baseline guardrails active
  ✓ 4 knowledge sources attached
  ✓ 0 Blocker flags
  ⚠ 1 Warning flag not yet acknowledged
  ✓ Evaluation Score: 94
  ```
- A warning callout if any Warning flags are unacknowledged: *"You're submitting with 1 unresolved Warning. Reviewers will see it."*
- Required reviewers list (from `apps[].approvalsRequired`):
  - Mock chips: *"Compliance Reviewer (Rina Salgado)"* · *"Compliance Co-Reviewer (Marco Davis)"*
  - Sub-line: *"Dual approval is required because this app touches Reg E disputes."*
- Free-text "Note to reviewers" textarea (optional)
- "Reviewers will see: configuration summary, SOP flags, Helper actions, Evaluation Report" (informational line)
- Primary action: **Confirm submission**
- Secondary: **Cancel**

### On Confirm

- Toast: *"Submitted to compliance review · 2 reviewers notified"*
- Sheet closes
- Process Owner is routed to a read-only view at `/queue/[appId]?from=submit` showing their submission's status (this is the same screen as Reviewer detail but with no approve/reject controls).
- App's status in `apps.ts` flips to `in_review` (in-memory only).

## Screen 2: Reviewer queue (`/queue`)

Persona: Compliance Reviewer.

### Header

- H1: *"Review queue"*
- Sub: *"3 apps awaiting your review · 1 has dual-approval pending your co-reviewer"*
- Right: filter chips: `All` `Pending me` `Pending co-reviewer` `Decided`

### Queue table

Columns:
- Submitted (relative time)
- App name (mono) + version
- Submitted by (avatar + name)
- Evaluation score (color-coded pill)
- Flags (e.g., `0/1/5` for Blocker/Warning/Suggestion)
- Helper edits (count — important for reviewer awareness per FR-APR-07)
- Status (chip: `Pending you`, `Pending co-reviewer`, `Awaiting both`)

Sort: oldest first by default (longest waiting at top).

Click a row → `/queue/[appId]`.

### Side rail (right, 280px)

- Title: *"Your decision stats this month"*
- Stats:
  - *"Reviewed: 14"*
  - *"Approved: 11"*
  - *"Changes requested: 2"*
  - *"Rejected: 1"*
  - *"Avg time to decision: 1 day 6 hours"*
- Below: *"Recently decided"* — short list of last 3 decisions, each linkable.

## Screen 3: Reviewer detail (`/queue/[appId]`)

The reviewer's read of one submission. This is where they Approve / Reject / Request Changes.

### Top band

- Breadcrumb: `Queue > card-dispute-triage`
- App name + version pill + status pill
- Submitted by (avatar) + when
- Right side: **Approve** (success-tinted) · **Request changes** (warning) · **Reject** (subtle error) buttons
  - Approve is disabled if there are unresolved Blocker flags
  - If dual approval is required and the reviewer is the co-reviewer, the primary "Approve" button reads "Co-approve" instead

### Structured plain-language summary (FR-APR-01)

A single panel containing the structured summary the reviewer reads first. Headings:

- **Purpose**: *(from `apps[].description`)*
- **Who it serves**: *Members · digital and voice channels · estimated audience 47,200*
- **What it knows**: *4 knowledge sources (Reg E playbook, card dispute disclosures, member identity policy, Cornerstone FAQ). Citation coverage 96% in last eval.*
- **What it won't do**: *Baseline 7 guardrails + 3 custom (no PII echo, no financial advice, …). All non-disable-able guardrails verified active.*
- **What it can touch**: *Reads: account balance, transaction history, KYC status. Writes: dispute case (Reg E case in Core Banking).*
- **What it remembers**: *Session memory only.*
- **SOP flags addressed**: *0 Blockers · 1 Warning unresolved · 5 Suggestions resolved.*
- **Helper actions taken**: *6 Helper-driven edits (3 guardrail additions, 2 knowledge re-attachments, 1 sub-agent removal). Provenance shown below.*

### Helper edits provenance panel

Important reviewer-specific view (FR-APR-07):

A list of changes the Helper proposed and the Process Owner accepted:

| When | Helper proposed | Process Owner action | Resulting change |
|---|---|---|---|
| 2 hr ago | Add guardrail "Require income-loss docs before drafting plan" | Confirmed | Guardrail added |
| 3 hr ago | Re-attach Reg E playbook | Confirmed | Knowledge re-attached |
| 5 hr ago | Remove `sa_financial_wellness` (not used in workflow) | Confirmed | Sub-agent removed |
| 5 hr ago | Reword response template | Skipped | (no change) |

Below: *"Helper-driven changes are called out so you can audit AI's role in this app. The Process Owner reviewed and explicitly confirmed each accepted change."*

### Evaluation Report embedded

A full-width panel showing the Evaluation Report (same as `05-evaluation.md`) but in read-only mode. Score, three-source breakdown, categories, top failing examples. Includes a "Drill into report →" link to the full report page.

### SOP issues addressed

Same list as in Review Studio (Panel 7) but with:
- Each flag shows its resolution state (Acknowledged / Resolved / Unresolved)
- Resolution notes from the Process Owner (if any) shown beneath

### Reviewer comments area

A textarea (visible at the bottom, sticky to the page): *"Comments to the Process Owner (optional)…"*

Below the textarea: **Approve** / **Request changes** / **Reject** buttons (mirror of the top band).

### Approval action behavior

- **Approve**:
  - Confirmation Dialog: *"Approve `card-dispute-triage` v3?"* with the reviewer's name and the timestamp shown.
  - On confirm: toast *"Approved. App is ready to deploy."* App's status flips to `approved`. Routes back to `/queue`.
  - If dual approval is required and the other reviewer hasn't approved yet, status flips to "Awaiting co-reviewer" instead, with a friendly note.
- **Request changes**:
  - Dialog requires a comment to be entered.
  - On confirm: toast, status flips to `changes_requested`. Routes to `/queue`.
- **Reject**:
  - Dialog requires a comment + a confirmation checkbox: *"I understand this app will not be deployable in its current form."*
  - On confirm: toast, status flips to draft state (no `rejected` end state in prototype; reads as draft so the Process Owner can re-iterate).

## Screen 4: Deploy confirmation (`/apps/[appId]/deploy`)

Reached from an approved app's Review Studio header ("Deploy →" button replaces "Submit for approval" once approved).

### Contents

- H1: *"Deploy `card-dispute-triage` v3"*
- Sub: *"Approved by Rina Salgado and Marco Davis on May 22, 2026."*
- Deployment summary panel:
  - Audience: *All members (~47,200)*
  - Channels: *Digital, Voice*
  - Deployment record will capture: *configuration snapshot v3, evaluation snapshot run #14 (score 94), approver IDs, deploy timestamp.*
  - Rollback target: *previous deployed version v2 (deployed May 12, 2026).*
- "What happens at deploy" callout:
  > *"The app becomes available to your target audience on the selected channels. Mission Control will start surfacing live metrics within a few minutes. Continuous evaluation will keep running against sampled live traffic."*
- Re-evaluation requirement note (FR-DEP-05): *"If you change this app after deployment, you'll need to re-evaluate and re-submit for approval before re-deploying."*
- Primary: **Deploy now** button (large, primary)
- Secondary: **Schedule deployment** (decorative — opens a Dialog with a date picker, "Schedule" button just toasts "Scheduled" and routes back)
- Tertiary: **Cancel**

### On Deploy

- Loader animation (~5 seconds), with sequential status text:
  1. *"Recording configuration snapshot…"*
  2. *"Validating evaluation snapshot…"*
  3. *"Capturing approval signatures…"*
  4. *"Provisioning channels (digital, voice)…"*
  5. *"Activating Mission Control surfaces…"*
- On completion:
  - Big success state: *"`card-dispute-triage` v3 deployed."* with a confetti-style subtle animation (Lucide `PartyPopper` icon, no real confetti library).
  - Sub-line: *"Available to all 47,200 members across digital and voice. Continuous evaluation begins now."*
  - Three follow-on CTAs: **Open Mission Control →** · **View deployment record** · **Back to dashboard**

## Click model

| Element | Action |
|---|---|
| Submit Sheet "Confirm submission" | Toast + status flip + route to read-only queue view |
| Queue row | → `/queue/[appId]` |
| Filter chips | Filter the table client-side |
| Reviewer "Approve" | Dialog → status flip → route to queue |
| Reviewer "Request changes" | Dialog (requires comment) → status flip → route |
| Reviewer "Reject" | Dialog (requires comment + checkbox) → status flip → route |
| Helper edits row | Hover shows full diff in tooltip |
| "Drill into report" | → `/apps/[appId]/evaluation` |
| Deploy "Deploy now" | 5-second animated deployment → success state |
| Deploy success "Open Mission Control" | → `/mission-control` |
| Deploy success "View deployment record" | Decorative Sheet with the snapshot content |

## States to render

- **Queue with 3 items** — default
- **Queue empty** — if filter excludes everything, show a friendly empty state: *"Nothing to review right now."* with a small Helper nudge.
- **Approve disabled** — when Blocker flags exist (use `loan-application-intake` if it ever reaches review).
- **Dual approval, one approver done** — show the pending co-reviewer chip.
- **Deploy success** — described above.

## Out of scope

- Real notifications to reviewers.
- Real configuration snapshotting.
- Real channel provisioning.
- Scheduled deployments beyond the visual decorator.
- Multi-environment deployment (no staging vs production in prototype).

## Acceptance criteria

- Submit Sheet calculates pre-flight checklist correctly from `apps.ts`.
- Reviewer queue renders 3 items with correct columns and status chips.
- Reviewer detail shows structured summary, Helper edits provenance, embedded eval, SOP issues, and decision buttons.
- Approve/Request changes/Reject flows all complete via Dialog and update status in-memory.
- Deploy flow plays through its 5-step animation and reaches the success state.
- Empty / dual-approval / Blocker-disabled states all render when triggered.
