# Arch — AI-Guided Project Lifecycle Assistant

> Design Specification for the Agent Platform's AI-powered project creation, agent design, and iterative development experience.

---

## 1. Naming & Identity

### The AI Assistant: **Arch**

Short for _Architect_. Minimal, modern, memorable.

- **Full feature name**: Arch — AI Agent Architect
- **Tagline**: "From idea to production. Together."
- **Personality**: Expert but approachable. Opinionated when it matters, flexible when it doesn't. Thinks in systems, explains in plain language.
- **Voice**: Concise, structured, uses bullet points and visual aids. Never verbose. Asks clarifying questions before assuming.

**Visual identity**: A small geometric logomark — an abstract "A" formed by two angled lines meeting at a point (like a compass/drafting tool). Rendered in the platform's accent color. Appears as a subtle avatar in the chat interface and as an icon in the sidebar.

---

## 2. Two Modes: Assisted & Pro

The entire studio experience adapts based on mode. Users can switch at any time.

### Assisted Mode (Default for new users)

| Aspect               | Behavior                                                 |
| -------------------- | -------------------------------------------------------- |
| Project creation     | Guided multi-stage wizard with Arch                      |
| Agent authoring      | Arch generates ABL from conversation, shows inline diffs |
| Topology             | Built incrementally as Arch designs agents               |
| Tools & integrations | Arch suggests and scaffolds tool definitions             |
| Testing              | Arch generates personas, scenarios, and eval sets        |
| Deployment           | Step-by-step deploy checklist with Arch validation       |
| Modifications        | "Hey Arch, add a billing agent" — conversational changes |

### Pro Mode (Power users)

| Aspect               | Behavior                                                          |
| -------------------- | ----------------------------------------------------------------- |
| Project creation     | Minimal form — name, description, domain. Jump straight to editor |
| Agent authoring      | Direct ABL editor (Monaco) with Arch available in sidebar panel   |
| Topology             | Manual drag-and-drop canvas                                       |
| Tools & integrations | Direct YAML/JSON configuration                                    |
| Testing              | Manual eval set configuration, CLI-driven runs                    |
| Deployment           | Direct deploy commands, CI/CD integration                         |
| Modifications        | Edit ABL directly, Arch provides inline suggestions on request    |

### Mode Switcher

Rendered in the top header bar, right side, next to the theme toggle:

```
┌─────────────────────────┐
│  ◉ Assisted    ○ Pro    │
└─────────────────────────┘
```

- Pill toggle with smooth slide animation
- Switching mid-flow preserves all state — just changes the UI chrome
- Assisted mode shows the Arch panel; Pro mode collapses it to a thin icon rail
- User preference persisted in Zustand store + localStorage

---

## 3. Project Lifecycle Stages

Every project moves through six stages. Arch guides users through each one in Assisted mode. In Pro mode, stages are visible as a progress indicator but don't gate navigation.

```
  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
  │  IDEATE  │───▶│  DESIGN  │───▶│  BUILD   │───▶│   TEST   │───▶│  DEPLOY  │───▶│  EVOLVE  │
  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
   Describe        Architect       Implement       Validate        Ship            Iterate
   the problem     the solution    the agents      the system      to production   and improve
```

### Stage 1: IDEATE — "What are we building?"

**Goal**: Capture the problem space, domain, and user intent.

**Arch's role**: Interviewer. Asks smart questions, extracts requirements.

**Layout**: Full-width conversational interface with a right-side summary panel.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to Projects          IDEATE  ●───○───○───○───○───○   Assisted ◉│
├──────────────────────────────────────────┬──────────────────────────────┤
│                                          │                              │
│  ┌─ Arch ──────────────────────────┐     │  PROJECT BRIEF              │
│  │                                  │     │                              │
│  │  Welcome! Let's design your      │     │  Domain                      │
│  │  agent system. Tell me:          │     │  ┌────────────────────────┐  │
│  │                                  │     │  │ Healthcare             │  │
│  │  1. What domain is this for?     │     │  └────────────────────────┘  │
│  │  2. What problem are you solving?│     │                              │
│  │  3. Who are the end users?       │     │  Use Cases                   │
│  │                                  │     │  ☑ Appointment scheduling    │
│  └──────────────────────────────────┘     │  ☑ Billing inquiries         │
│                                          │  ☑ Lab result retrieval       │
│  ┌─ You ───────────────────────────┐     │  ☐ Prescription management   │
│  │                                  │     │                              │
│  │  We're building a healthcare     │     │  Users                       │
│  │  contact center. Patients call   │     │  • Patients                  │
│  │  about appointments, billing,    │     │  • Nurses                    │
│  │  and lab results. We want AI     │     │                              │
│  │  agents to handle the first      │     │  Channels                    │
│  │  line of support.                │     │  • Chat  • Voice  • Web      │
│  └──────────────────────────────────┘     │                              │
│                                          │  Tone                        │
│  ┌─ Arch ──────────────────────────┐     │  Empathetic, professional    │
│  │                                  │     │                              │
│  │  Great — a healthcare triage     │     │  ─────────────────────────── │
│  │  system. A few clarifications:   │     │                              │
│  │                                  │     │  Estimated Agents: 5-7       │
│  │  • Should agents handle          │     │  Complexity: Medium          │
│  │    prescription refills too?     │     │                              │
│  │  • Do patients authenticate      │     │                              │
│  │    (e.g., with a member ID)?    │     │                              │
│  │  • Is there a human escalation   │     │                              │
│  │    path for emergencies?        │     │                              │
│  │                                  │     │                              │
│  └──────────────────────────────────┘     │                              │
│                                          │                              │
│  ┌──────────────────────────────────┐     │                              │
│  │  Type your response...        ↵  │     │  ┌────────────────────────┐  │
│  └──────────────────────────────────┘     │  │  Continue to Design →  │  │
│                                          │  └────────────────────────┘  │
├──────────────────────────────────────────┴──────────────────────────────┤
│  💡 You can also upload docs: API specs, call scripts, process flows    │
│     ┌──────────┐                                                        │
│     │ + Upload  │                                                       │
│     └──────────┘                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key interactions**:

- Arch asks 3-5 targeted questions based on domain
- Right panel auto-populates a "Project Brief" as user responds
- User can upload reference documents (PDFs, API specs, call scripts)
- Arch extracts requirements from uploads and confirms understanding
- Brief fields are editable — user can override Arch's inferences
- "Continue to Design" enabled once Arch has enough context

**Uploads**: Drag-and-drop zone at the bottom. Supported: PDF, MD, JSON, YAML, TXT, DOCX. Arch processes them and says "I found X endpoints in your API spec" or "Your call script mentions 4 main intents".

---

### Stage 2: DESIGN — "How should it work?"

**Goal**: Architecture the agent topology, define agent roles, tools, and interactions.

**Arch's role**: Architect. Proposes a system design, explains trade-offs.

**Layout**: Split view — Arch conversation on left, live topology canvas on right.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back                          DESIGN  ○───●───○───○───○───○         │
├──────────────────────────────────────────┬──────────────────────────────┤
│                                          │                              │
│  ┌─ Arch ──────────────────────────┐     │    ┌──────────────┐         │
│  │                                  │     │    │  MediAssist   │  ←entry│
│  │  Based on your requirements,     │     │    │  supervisor   │         │
│  │  here's my proposed design:      │     │    └──────┬───────┘         │
│  │                                  │     │     ┌─────┼─────┐           │
│  │  ▸ 1 Supervisor (MediAssist)     │     │     │     │     │           │
│  │    Routes by intent type         │     │  ┌──▼──┐┌─▼──┐┌─▼──┐      │
│  │                                  │     │  │Appt ││Bill││Lab  │      │
│  │  ▸ 3 Specialist Agents:          │     │  │Book ││Supp││Rslt │      │
│  │    • Appointment_Booking         │     │  └──┬──┘└─┬──┘└─┬──┘      │
│  │      - scripted, 6 flow steps   │     │     │     │     │           │
│  │      - tools: check_availability│     │     └─────┼─────┘           │
│  │        book_appointment          │     │           │                  │
│  │    • Billing_Support             │     │     ┌─────▼─────┐           │
│  │      - reasoning mode           │     │     │  Escalate  │           │
│  │      - tools: get_balance,      │     │     │  to Human  │           │
│  │        process_payment           │     │     └───────────┘           │
│  │    • Lab_Results                 │     │                              │
│  │      - scripted, 3 steps        │     │  ──────────────────────────  │
│  │      - tools: fetch_results     │     │                              │
│  │                                  │     │  AGENT DETAILS              │
│  │  ▸ Escalation to human for:      │     │  ┌────────────────────────┐ │
│  │    • Emergency symptoms          │     │  │ Appointment_Booking    │ │
│  │    • Payment disputes > $500     │     │  │ Mode: scripted         │ │
│  │    • 3 failed auth attempts      │     │  │ Steps: 6               │ │
│  │                                  │     │  │ Tools: 3               │ │
│  │  Does this look right? I can:    │     │  │ Gather: 4 fields       │ │
│  │  • Add/remove agents             │     │  │ Constraints: 2         │ │
│  │  • Change execution modes        │     │  └────────────────────────┘ │
│  │  • Adjust escalation rules       │     │                              │
│  │                                  │     │  ┌────────────────────────┐ │
│  └──────────────────────────────────┘     │  │ View Flow Diagram →    │ │
│                                          │  └────────────────────────┘ │
│  ┌──────────────────────────────────┐     │                              │
│  │  Type your response...        ↵  │     │                              │
│  └──────────────────────────────────┘     │  ┌────────────────────────┐ │
│                                          │  │  Continue to Build →   │ │
│                                          │  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key interactions**:

- Arch proposes a full topology based on the IDEATE brief
- Topology canvas renders in real-time as Arch describes agents
- Clicking a node in the canvas shows agent details in a panel
- User can request changes conversationally: "Make billing a reasoning agent" or "Add a pharmacy agent"
- Arch updates the topology live and explains the change
- Flow diagrams available per agent (vertical step visualization)
- Architecture decisions are tracked (Arch explains _why_ supervisor vs. flat, scripted vs. reasoning)

**Topology Canvas**: SVG-based graph using the existing `TopologyCanvas` component from spec-mock. Nodes are color-coded by type (supervisor = accent, agent = subtle). Edges show routing (solid), handoff (solid), escalation (dashed).

---

### Stage 3: BUILD — "Let's implement it."

**Goal**: Generate ABL code, configure tools, set up integrations.

**Arch's role**: Pair programmer. Generates ABL, explains code, applies changes.

**Layout**: Three-panel — Arch sidebar on left, code editor center, preview right.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back                          BUILD  ○───○───●───○───○───○          │
├───────────────┬──────────────────────────────────┬──────────────────────┤
│               │                                  │                      │
│  ARCH         │  appointment_booking.agent.abl   │  PREVIEW             │
│  ─────────    │  ────────────────────────────────│  ────────            │
│               │                                  │                      │
│  I've genera- │  AGENT: Appointment_Booking      │  Flow Diagram        │
│  ted the ABL  │  MODE: scripted                  │  ┌────────────┐     │
│  for all 3    │  DOMAIN: healthcare              │  │  GATHER    │     │
│  agents.      │                                  │  │ patient_id │     │
│               │  PERSONA: |                      │  │ date_pref  │     │
│  Currently    │    You are a friendly appointment│  └─────┬──────┘     │
│  viewing:     │    scheduling assistant...        │        │             │
│  ▸ Appt_Book  │                                  │  ┌─────▼──────┐     │
│    Billing    │  TOOLS:                          │  │ check_avail│     │
│    Lab_Result │    check_availability(           │  └─────┬──────┘     │
│    MediAssist │      date: date,                 │        │             │
│               │      doctor_id: string           │  ┌─────▼──────┐     │
│  ───────────  │    ) -> { slots: array }         │  │ confirm    │     │
│               │                                  │  └─────┬──────┘     │
│  What would   │    book_appointment(             │        │             │
│  you like to  │      patient_id: string,         │  ┌─────▼──────┐     │
│  change?      │      slot_id: string             │  │ book_appt  │     │
│               │    ) -> { confirmation: object } │  └─────┬──────┘     │
│  Suggestions: │                                  │        │             │
│  ┌──────────┐ │  GATHER:                         │  ┌─────▼──────┐     │
│  │Add auth  │ │    patient_id:                   │  │  COMPLETE   │     │
│  │step      │ │      type: string                │  └────────────┘     │
│  └──────────┘ │      required: true              │                      │
│  ┌──────────┐ │      prompt: "What's your..."    │  ─────────────────── │
│  │Add error │ │    ...                           │                      │
│  │handling  │ │                                  │  Topology (mini)     │
│  └──────────┘ │  FLOW:                           │  ┌────┐             │
│  ┌──────────┐ │    entry_point: greet            │  │Supv├─▸ ★         │
│  │Configure │ │    steps:                        │  └─┬──┘             │
│  │escalation│ │      - greet                     │    ├─▸ Bill         │
│  └──────────┘ │      - collect_info              │    └─▸ Lab          │
│               │      - check_availability        │                      │
│               │      - confirm_slot              │  ★ = current agent   │
│               │      - book                      │                      │
│               │      - complete                  │                      │
│               │                                  │                      │
│               │    greet:                         │                      │
│               │      RESPOND: |                  │                      │
│               │        Hello! I can help you...  │                      │
│               │      THEN: collect_info          │                      │
│               │    ...                           │                      │
├───────────────┴──────────────────────────────────┴──────────────────────┤
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Ask Arch anything... "add a cancellation flow"              ↵  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key interactions**:

- Arch generates complete ABL for every agent from the design
- Monaco editor with ABL syntax highlighting (center panel)
- Agent file tabs — switch between agents
- Preview panel shows flow diagram + mini topology
- Arch sidebar shows contextual suggestions (proactive chips)
- User can request changes conversationally: "Add a cancellation flow after booking"
- Arch shows **inline diffs** before applying:

```
┌─ Arch ──────────────────────────────────────────┐
│                                                  │
│  I'll add a cancellation option after booking.   │
│  Here's the change:                              │
│                                                  │
│  ┌─ Diff ──────────────────────────────────────┐ │
│  │   book:                                      │ │
│  │     CALL: book_appointment WITH: ...         │ │
│  │     RESPOND: "Your appointment is booked!"   │ │
│  │ -   THEN: complete                           │ │
│  │ +   THEN: post_book                          │ │
│  │ +                                            │ │
│  │ + post_book:                                 │ │
│  │ +   ASK: "Need anything else? I can also     │ │
│  │ +     cancel or reschedule."                 │ │
│  │ +   ON_INPUT:                                │ │
│  │ +     - IF: input CONTAINS "cancel"          │ │
│  │ +       THEN: cancel_flow                    │ │
│  │ +     - ELSE:                                │ │
│  │ +       THEN: complete                       │ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  ┌──────────┐  ┌──────────┐                      │
│  │  Apply   │  │  Reject  │                      │
│  └──────────┘  └──────────┘                      │
└──────────────────────────────────────────────────┘
```

- **Apply** updates the editor. **Reject** discards.
- Arch can also explain any line: user selects code → "Explain this" context menu
- Compilation happens live — errors shown inline in editor and Arch proactively offers fixes

**Proactive Suggestion Chips**: Arch analyzes the current ABL and surfaces actionable suggestions as clickable chips:

- "Add authentication step" — if no auth detected
- "Add error handling" — if tools lack ON_ERROR
- "Configure escalation" — if no escalation path defined
- "Add constraints" — if no guardrails set
- These chips are contextual and update as the user builds

---

### Stage 4: TEST — "Does it work?"

**Goal**: Validate agents with simulated conversations, personas, and evaluation sets.

**Arch's role**: QA lead. Generates test personas, scenarios, runs evals.

**Layout**: Split view — Arch + chat on left, test results on right.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back                           TEST  ○───○───○───●───○───○          │
├──────────────────────────────────────────┬──────────────────────────────┤
│                                          │                              │
│  LIVE TEST                               │  TEST SUITE                  │
│  ─────────                               │  ──────────                  │
│                                          │                              │
│  ┌─ MediAssist ────────────────────┐     │  Personas          ┌─ + ──┐ │
│  │  Hello! Welcome to MediAssist.  │     │  ┌──────────────┐  │ New  │ │
│  │  How can I help you today?      │     │  │ 😤 Frustrated │  └──────┘ │
│  └──────────────────────────────────┘     │  │    Patient    │           │
│                                          │  ├──────────────┤           │
│  ┌─ You ───────────────────────────┐     │  │ 👴 Elderly    │           │
│  │  I need to book an appointment  │     │  │    Patient    │           │
│  │  with Dr. Smith next Tuesday.   │     │  ├──────────────┤           │
│  └──────────────────────────────────┘     │  │ 👩‍⚕️ Tech-Savvy │           │
│                                          │  │    Nurse      │           │
│  ┌─ Appointment_Booking ───────────┐     │  └──────────────┘           │
│  │  I'll check Dr. Smith's         │     │                              │
│  │  availability for next Tuesday. │     │  Scenarios         ┌─ + ──┐ │
│  │                                  │     │  ┌──────────────┐  │ New  │ │
│  │  ▸ Trace: check_availability    │     │  │ Booking flow │  └──────┘ │
│  │    → 3 slots found (230ms)      │     │  │ Billing disp │           │
│  │                                  │     │  │ Emergency    │           │
│  │  Here are the available slots:  │     │  │ Lab results  │           │
│  │  • 9:00 AM  • 11:30 AM  • 2 PM │     │  └──────────────┘           │
│  └──────────────────────────────────┘     │                              │
│                                          │  Eval Runs                   │
│  ┌──────────────────────────────────┐     │  ┌──────────────────────┐   │
│  │  Type a message...            ↵  │     │  │ ▶ Run Full Suite     │   │
│  └──────────────────────────────────┘     │  └──────────────────────┘   │
│                                          │                              │
│  ─── ARCH INSIGHTS ──────────────────    │  Last Run: 4.2/5.0 avg      │
│                                          │  ┌──────────────────────┐   │
│  ⚡ Agent responded in 1.2s avg          │  │ Task Completion  4.5 │   │
│  ⚠ No fallback if Dr. Smith is           │  │ Response Quality 4.3 │   │
│    unavailable on that date              │  │ Safety           4.8 │   │
│  ✓ Proper handoff to supervisor          │  │ Efficiency       3.2 │   │
│  💡 Consider adding "Would you like      │  └──────────────────────┘   │
│     to try another date?" fallback       │                              │
│                                          │                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key interactions**:

- Live chat testing with real agent execution
- Inline trace summaries (expandable) showing tool calls, duration, tokens
- Arch observes the conversation and provides real-time insights:
  - Performance notes (response time)
  - Missing edge cases (no fallback for unavailable dates)
  - Quality suggestions (better phrasing, missing confirmation)
- Persona/Scenario generation: Arch suggests test personas based on the domain
- Eval framework: Run automated test suites with LLM-judge evaluators
- Heat map results showing score breakdown by persona x scenario x evaluator
- Arch summarizes test results: "Your booking flow scores well but billing has low efficiency scores. The payment tool is being called twice per conversation."

---

### Stage 5: DEPLOY — "Ship it."

**Goal**: Deploy to staging/production with validation gates.

**Arch's role**: Release engineer. Validates readiness, guides deployment.

**Layout**: Checklist view with Arch commentary.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back                         DEPLOY  ○───○───○───○───●───○          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  DEPLOYMENT READINESS                                                   │
│  ────────────────────                                                   │
│                                                                         │
│  ┌─ Arch ──────────────────────────────────────────────────────────┐   │
│  │  Your project is almost ready. Here's the pre-flight check:     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  ✅  All agents compile successfully          3/3 agents          │  │
│  │  ✅  No critical constraint violations         0 violations       │  │
│  │  ✅  All tools have endpoints configured       7/7 tools          │  │
│  │  ⚠️  Eval coverage below 80%                   72% covered        │  │
│  │      └─ Lab_Results agent has no test scenarios                    │  │
│  │  ✅  Escalation paths configured               2 paths            │  │
│  │  ✅  Error handlers present                    All agents         │  │
│  │  ⚠️  No rate limiting configured                                   │  │
│  │      └─ Arch recommends: 100 req/min per user                     │  │
│  │                                                                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ENVIRONMENTS                                                           │
│  ┌─────────────────────────┐  ┌─────────────────────────┐              │
│  │  Staging                 │  │  Production              │              │
│  │  v1.0.0-rc.1            │  │  Not deployed            │              │
│  │  Deployed 2h ago         │  │                          │              │
│  │  3 active sessions       │  │  ┌──────────────────┐   │              │
│  │                          │  │  │  Deploy to Prod   │   │              │
│  │  ┌──────────────────┐   │  │  └──────────────────┘   │              │
│  │  │  Redeploy         │   │  │                          │              │
│  │  └──────────────────┘   │  │                          │              │
│  └─────────────────────────┘  └─────────────────────────┘              │
│                                                                         │
│  VERSION HISTORY                                                        │
│  v1.0.0-rc.1   Today 2:30 PM    "Initial staging deploy"    ↺ Rollback│
│  v0.9.0        Yesterday        "Added billing agent"        ↺ Rollback│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Stage 6: EVOLVE — "Make it better."

**Goal**: Iterate on the deployed system. Add features, fix issues, optimize.

**Arch's role**: Advisor. Analyzes production data, suggests improvements.

This is not a separate page — it's the **ongoing state** of the project. Once deployed, the project returns to a workspace view where Arch is always available in the sidebar.

**Arch proactively surfaces**:

- "Billing agent has 23% escalation rate — above the 15% threshold. Want me to analyze the conversations?"
- "Users frequently ask about prescription refills but there's no agent for it. Should I design one?"
- "The check_availability tool is timing out 8% of the time. Consider adding a retry with backoff."

**Conversational modifications**:

```
You: "Add a pharmacy agent that handles prescription refills"

Arch: "I'll design a Pharmacy_Refill agent. Based on your existing patterns:

  • Mode: scripted (matches your other transactional agents)
  • Tools needed: check_prescription, submit_refill, get_pharmacy_status
  • Gather fields: patient_id, prescription_id, preferred_pharmacy
  • Estimated: 5 flow steps

  Here's the topology change:

  [Updated topology showing new agent connected to supervisor]

  Should I generate the ABL?"
```

---

## 4. The Arch Side Panel (Persistent Assistant)

Once a project exists, Arch is always accessible as a **collapsible side panel** on any page.

### Collapsed State (Icon Rail)

```
┌──┐
│ A│  ← Arch icon, click to expand
│  │
│  │
└──┘
```

### Expanded State (320px panel)

```
┌────────────────────────────┐
│  ARCH              ✕ │ ⊟ │
│  ─────────────────────────│
│                            │
│  Context: Billing_Support  │
│  Page: Agent Editor        │
│                            │
│  ┌─ Arch ────────────────┐ │
│  │ I see you're editing   │ │
│  │ the billing agent.     │ │
│  │ What do you need?      │ │
│  └────────────────────────┘ │
│                            │
│  Quick Actions:            │
│  ┌────────────────────────┐ │
│  │ 🔍 Explain this code   │ │
│  │ 🔧 Add error handling  │ │
│  │ ✨ Suggest improvements │ │
│  │ 🧪 Generate tests      │ │
│  └────────────────────────┘ │
│                            │
│  ┌────────────────────────┐ │
│  │ Ask Arch...         ↵  │ │
│  └────────────────────────┘ │
└────────────────────────────┘
```

**Context awareness**: Arch knows which page, agent, and section you're viewing. Opens with relevant context already loaded.

**Quick Actions**: Contextual action chips that change based on the current page:

- On Agent Editor: Explain, Add error handling, Suggest improvements, Generate tests
- On Sessions: Analyze this conversation, Find the bug, Suggest fix
- On Overview: Summarize health, Identify bottlenecks, Suggest optimizations
- On Evals: Generate personas, Create scenarios, Explain scores

---

## 5. New Project Creation Flow (Detailed)

### Entry Point

From the Project Dashboard, the "New Project" button opens a dropdown:

```
┌────────────────────────────────┐
│  ✨ Start with Arch             │  ← AI-guided (recommended)
│     AI designs your project    │
├────────────────────────────────┤
│  📄 Blank Project              │  ← Empty project, manual setup
│     Start from scratch         │
├────────────────────────────────┤
│  📋 From Template              │  ← Pre-built domain starters
│     Banking, Healthcare, ...   │
└────────────────────────────────┘
```

### "Start with Arch" Flow

**URL**: `/projects/new`

**Full-screen experience** (exits the normal sidebar layout):

#### Step 1: Describe (IDEATE)

Arch interviews the user. See Stage 1 layout above.

- Conversation with Arch on the left
- Auto-populating Project Brief on the right
- Upload zone for reference documents
- Arch processes uploads and extracts requirements

**Transition**: Once Arch has gathered enough info (domain, use cases, users, channels), the "Continue" button activates.

#### Step 2: Architect (DESIGN)

Arch proposes a topology. See Stage 2 layout above.

- Conversation continues on the left
- Topology canvas renders on the right, animated node-by-node
- User can request changes, add/remove agents
- Agent detail panel shows on node click

**Transition**: Once user approves the topology ("Looks good!"), continue to next step.

#### Step 3: Review & Create

Summary of everything before project creation:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        REVIEW & CREATE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Project Name                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  MediAssist                                                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Description                                                            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Healthcare contact center with AI agents for appointments,       │  │
│  │  billing, and lab results.                                        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────┐  ┌────────────────────────────────┐  │
│  │  TOPOLOGY                     │  │  AGENTS                        │  │
│  │  ┌────┐                       │  │                                │  │
│  │  │Supv├─┬─▸ Appt             │  │  MediAssist (supervisor)       │  │
│  │  └────┘ ├─▸ Bill             │  │  Appointment_Booking (scripted)│  │
│  │         └─▸ Lab              │  │  Billing_Support (reasoning)   │  │
│  │                               │  │  Lab_Results (scripted)        │  │
│  └──────────────────────────────┘  └────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────┐  ┌────────────────────────────────┐  │
│  │  TOOLS           7 total      │  │  INTEGRATIONS                  │  │
│  │  check_availability           │  │  REST API endpoints            │  │
│  │  book_appointment             │  │  Human escalation              │  │
│  │  get_balance                  │  │  Webhook notifications         │  │
│  │  process_payment              │  │                                │  │
│  │  fetch_results                │  │                                │  │
│  │  ...                          │  │                                │  │
│  └──────────────────────────────┘  └────────────────────────────────┘  │
│                                                                         │
│              ┌────────────────────────────────────┐                     │
│              │       Create Project                │                     │
│              └────────────────────────────────────┘                     │
│                                                                         │
│  Creating this project will generate ABL files for all agents.          │
│  You can modify everything after creation.                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**On "Create Project"**:

1. Create project in database
2. Generate ABL files for all agents
3. Compile to IR
4. Navigate to project workspace (BUILD stage)
5. Arch greets: "Your project is ready! I've generated ABL for all 4 agents. Start by reviewing the supervisor agent, or ask me to make any changes."

---

## 6. Iterative Agent Modification with Arch

The core power of Arch is **conversational iteration** on existing agents. This works from any context.

### From the Agent Editor (BUILD stage)

User is viewing an agent's ABL in the editor. Arch panel is open.

**Example: Adding a feature**

```
You: "I want to add appointment cancellation to this agent"

Arch: "I'll add a cancellation flow. This requires:

  1. A new tool: cancel_appointment(appointment_id) -> { success }
  2. A new gather field: cancellation_reason (optional)
  3. New flow steps: cancel_confirm → cancel_execute → cancel_complete
  4. A branch after booking: ask if they want to cancel/reschedule

  Here's the diff:

  [Inline diff showing all changes]

  ┌──────────┐  ┌──────────┐
  │  Apply   │  │  Modify  │
  └──────────┘  └──────────┘"
```

**Example: Fixing an issue**

```
You: "Users are getting stuck when the payment tool fails"

Arch: "I see the issue. The process_payment step has no ON_ERROR handler.
  When the tool fails, the conversation dead-ends.

  I'll add:
  1. Retry logic (up to 2 retries with exponential backoff)
  2. A user-friendly error message
  3. An escalation path if retries are exhausted

  [Inline diff]

  ┌──────────┐  ┌──────────┐
  │  Apply   │  │  Modify  │
  └──────────┘  └──────────┘"
```

**Example: Adding an agent**

```
You: "We need a new agent for insurance claims"

Arch: "I'll design an Insurance_Claims agent. Based on your existing patterns:

  • Mode: reasoning (claims require flexible conversation)
  • Tools: submit_claim, check_claim_status, upload_document
  • Gather: patient_id, claim_type, incident_date, supporting_docs
  • Constraints: Must verify insurance before processing
  • Escalation: Claims over $10,000 → human review

  I'll also update the supervisor routing to include insurance intents.

  Should I generate the ABL?"
```

### From the Sessions Page (EVOLVE stage)

User is viewing a problematic conversation session.

```
You: "What went wrong in this session?"

Arch: "Looking at the trace...

  Turn 3: User asked about lab results
  Turn 4: Supervisor routed to Lab_Results agent ✓
  Turn 5: fetch_results tool called → timeout after 5000ms ✗
  Turn 6: No ON_ERROR handler → agent went silent
  Turn 7: User repeated question
  Turn 8: Same timeout → user abandoned

  Root cause: The fetch_results tool has a 5s timeout but the lab
  API averages 8s response time.

  Fix options:
  1. Increase tool timeout to 15s
  2. Add a 'please wait' message while fetching
  3. Add retry with a progress indicator

  Want me to implement option 2 + 3?"
```

---

## 7. Visual Design Specifications

### Color System (extending existing)

```css
/* Arch-specific colors */
--arch-bg: var(--bg-elevated); /* Panel background */
--arch-border: var(--border); /* Panel border */
--arch-accent: var(--purple); /* AI-specific accent */
--arch-bubble-bg: var(--bg-subtle); /* Arch message bubble */
--arch-user-bubble: var(--bg-muted); /* User message bubble */
--arch-suggestion: var(--accent); /* Suggestion chip color */
```

### Typography

- **Arch messages**: `text-sm` (14px), `font-normal`, `text-fg`
- **Code in messages**: `font-mono`, `text-xs` (12px), `bg-bg-muted`, `rounded`, `px-1`
- **Stage labels**: `text-xs` (12px), `font-semibold`, `uppercase`, `tracking-wider`, `text-fg-muted`
- **Section headers**: `text-sm` (14px), `font-semibold`, `text-fg`

### Spacing

- **Chat bubble padding**: `px-4 py-3`
- **Chat gap between messages**: `gap-3`
- **Panel padding**: `p-4`
- **Section gap**: `gap-6`

### Animation

- **Message entrance**: `fade-in-up` (200ms, ease-out)
- **Topology node entrance**: Stagger 150ms per node, scale from 0.8 → 1.0
- **Diff appearance**: `slide-in-right` (250ms)
- **Stage transition**: Cross-fade (300ms)
- **Panel expand/collapse**: Width animation (200ms, spring)
- **Suggestion chip entrance**: `fade-in` stagger 100ms

### Chat Bubble Design

````
┌─ Agent name ─────────────────────────────────────┐
│                                                    │
│  Message content with **markdown** support.        │
│                                                    │
│  • Bullet points                                   │
│  • Are supported                                   │
│                                                    │
│  ```abl                                            │
│  AGENT: Example                                    │
│  ```                                               │
│                                                    │
│                                          12:34 PM  │
└────────────────────────────────────────────────────┘
````

- **Arch bubbles**: Left-aligned, `bg-bg-subtle`, `border-border`, `rounded-xl rounded-tl-sm`
- **User bubbles**: Right-aligned, `bg-accent/10`, `border-accent/20`, `rounded-xl rounded-tr-sm`
- **Agent name**: `text-xs font-medium text-fg-muted` above bubble
- **Timestamp**: `text-[10px] text-fg-subtle` bottom-right inside bubble

### Progress Indicator (Stage Stepper)

```
  ●━━━━━○━━━━━○━━━━━○━━━━━○━━━━━○
IDEATE  DESIGN  BUILD   TEST  DEPLOY  EVOLVE

● = completed (accent filled)
◉ = current (accent filled + ring)
○ = upcoming (border only)
━ = connector (accent if completed, border if not)
```

- Horizontal on desktop, vertical on mobile
- Clickable in Pro mode (free navigation)
- Sequential in Assisted mode (can go back, not skip forward)
- Subtle label below each dot: `text-[10px] uppercase tracking-wider`

---

## 8. Component Architecture

### New Components Required

```
src/components/
├── arch/
│   ├── ArchPanel.tsx              # Collapsible side panel
│   ├── ArchChat.tsx               # Chat interface (messages + input)
│   ├── ArchMessage.tsx            # Individual message bubble
│   ├── ArchSuggestionChips.tsx    # Proactive action chips
│   ├── ArchDiffView.tsx           # Inline diff with Apply/Reject
│   ├── ArchIcon.tsx               # Arch avatar/icon
│   ├── PlanMessage.tsx            # Plan display in chat
│   └── ProposalMessage.tsx        # Proposal display in chat
├── onboarding/                    # Replaced lifecycle/ wizard stages
│   ├── ArchOnboarding.tsx         # Main onboarding orchestrator
│   ├── InterviewPhase.tsx         # AI-guided interview (was IdeateStage)
│   ├── RevealPhase.tsx            # Topology reveal (was DesignStage)
│   ├── ReviewPhase.tsx            # Review generated artifacts
│   ├── CreatePhase.tsx            # Project creation
│   ├── GeneratingPhase.tsx        # Generation progress
│   ├── WelcomePhase.tsx           # Welcome screen
│   ├── UploadPhase.tsx            # Upload existing project
│   └── index.ts                   # Barrel exports
├── creation/
│   └── NewProjectDropdown.tsx     # Entry: Arch / Blank / Template
└── topology/
    └── TopologyCanvas.tsx         # Agent topology visualization
```

### State Management

```typescript
// New Zustand store: arch-store.ts
interface ArchStore {
  // Panel state
  isOpen: boolean;
  isMinimized: boolean;
  toggle: () => void;

  // Mode
  mode: 'assisted' | 'pro';
  setMode: (mode: 'assisted' | 'pro') => void;

  // Conversation
  messages: ArchMessage[];
  isTyping: boolean;
  sendMessage: (text: string) => Promise<void>;

  // Context awareness
  currentContext: {
    page: string;
    agentId?: string;
    sessionId?: string;
  };
  setContext: (ctx: Partial<ArchContext>) => void;

  // Suggestions
  suggestions: ArchSuggestion[];

  // Pending diffs
  pendingDiff: ArchDiff | null;
  applyDiff: () => void;
  rejectDiff: () => void;
}

// New Zustand store: lifecycle-store.ts
interface LifecycleStore {
  currentStage: 'ideate' | 'design' | 'build' | 'test' | 'deploy' | 'evolve';
  completedStages: Set<string>;
  projectBrief: ProjectBrief;
  proposedTopology: TopologyData | null;
  generatedAgents: GeneratedAgent[];
  setStage: (stage: string) => void;
  updateBrief: (updates: Partial<ProjectBrief>) => void;
}
```

---

## 9. API Design

### Arch Backend Endpoints

```
POST /api/arch/chat
  Body: { projectId?, stage, messages[], context, attachments? }
  Response: { message, suggestions?, topology?, diff?, brief? }

POST /api/arch/generate
  Body: { projectId, type: 'agent' | 'topology' | 'tests', brief }
  Response: { artifacts: GeneratedArtifact[] }

POST /api/arch/analyze
  Body: { projectId, agentId?, sessionId?, type: 'health' | 'suggestions' | 'debug' }
  Response: { analysis, suggestions, issues }

POST /api/arch/apply-diff
  Body: { projectId, agentId, diff }
  Response: { success, updatedContent }
```

### Arch uses the platform's LLMProvider

Arch is powered by the same LLM infrastructure as the agents themselves. It uses:

- Claude (or configured model) for conversation
- Structured output for topology generation, ABL generation, and analysis
- Tool use for accessing project data, compilation results, and session traces
- Context from the Project Brief, current agent ABL, and session history

---

## 10. Implementation Phases

### Phase 1: Foundation (MVP)

- [ ] `ArchPanel` component (collapsible sidebar)
- [ ] `ArchChat` with message rendering (markdown, code blocks)
- [ ] Assisted/Pro mode toggle + persistence
- [ ] `LifecycleStepper` component
- [ ] Backend: `/api/arch/chat` endpoint with basic LLM integration
- [ ] Wire up to existing project creation flow

### Phase 2: Project Creation Wizard

- [ ] `NewProjectDropdown` with three options
- [ ] Full-screen `NewProjectWizard` shell
- [ ] `IdeateStage` — conversation + Project Brief panel
- [ ] `DesignStage` — conversation + topology canvas
- [ ] `ReviewAndCreate` — summary + creation
- [ ] Port `TopologyCanvas` from spec-mock
- [ ] Backend: topology generation from brief
- [ ] Backend: ABL generation from topology

### Phase 3: Build Integration

- [ ] Arch sidebar in Agent Editor
- [ ] `ArchDiffView` — inline diffs with Apply/Reject
- [ ] `ArchSuggestionChips` — proactive suggestions
- [ ] Context awareness (knows which agent/page)
- [ ] Backend: ABL modification from natural language
- [ ] Live compilation feedback

### Phase 4: Test & Deploy

- [ ] Arch integration in Test stage
- [ ] Auto-generate personas and scenarios
- [ ] Deployment readiness checklist
- [ ] Backend: session analysis and debugging

### Phase 5: Evolve & Polish

- [ ] Production insights and proactive suggestions
- [ ] Arch learns project patterns over time
- [ ] Upload processing (PDF, API specs)
- [ ] Animations and transitions polish

---

## 11. Key Design Principles

1. **Arch is opinionated, not prescriptive**. It proposes best practices but users can override.
2. **Show, don't tell**. Topology renders live. Diffs show exact changes. Flow diagrams update in real-time.
3. **Progressive disclosure**. Simple questions first, complexity later. Don't overwhelm on step 1.
4. **Escape hatches everywhere**. User can switch to Pro mode, edit ABL directly, or close Arch at any time.
5. **Context is king**. Arch always knows what you're looking at. No "what agent are you referring to?" questions.
6. **Diffs, not replacements**. Arch never silently replaces code. Always shows what will change.
7. **Conversation is persistent**. Chat history is preserved per-project. You can reference earlier discussions.
8. **Suggestions are actionable**. Every suggestion chip does something when clicked. No vague advice.

---

## Appendix: Naming Alternatives Considered

| Name      | Pros                                   | Cons                               |
| --------- | -------------------------------------- | ---------------------------------- |
| **Arch**  | Short, clear, "architect" reference    | Generic                            |
| Blueprint | Matches ABL (Agent Blueprint Language) | Too long for a chat assistant name |
| Forge     | Creative, "crafting" metaphor          | Doesn't convey intelligence        |
| Compass   | Guiding metaphor                       | Too generic                        |
| Muse      | Creative inspiration                   | Too artistic for engineering       |
| Pilot     | Copilot reference                      | Overused in AI space               |
| Sage      | Wisdom, advisory                       | Too mystical                       |

**Decision**: **Arch** — shortest, clearest connection to the architect role, works as both a name and a verb ("Let Arch design your agents").
