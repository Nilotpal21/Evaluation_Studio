# ABL Architect Tools

The Architect Tools are a set of MCP (Model Context Protocol) tools that help you design, generate, and validate ABL agents. These tools are available through Claude Code via the `kore-platform-cli` package.

## Overview

The architect workflow helps you go from a use case description to a fully scaffolded ABL project:

```
Use Case Description
        │
        ▼
┌───────────────────┐
│  Analyze Use Case │  ← Identifies agent types, tools, workflows
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  Detect ABL Gaps  │  ← Identifies limitations & suggests alternatives
└───────────────────┘
        │
        ▼
┌───────────────────┐
│   Generate ABL    │  ← Creates agent definitions
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Scaffold Project  │  ← Creates directory structure with docs
└───────────────────┘
        │
        ▼
┌───────────────────┐
│   Validate ABL    │  ← Checks syntax and structure
└───────────────────┘
```

## Available Tools

### `kore_architect_analyze`

Analyzes a use case description and produces an architecture specification.

**Input:**

- `use_case`: Natural language description of what the agent should do
- `complexity`: Optional hint - `simple`, `moderate`, or `complex`

**Output:**

- Suggested topology (single-agent, supervisor, adaptive-network)
- List of required agents with their purposes
- Required tools and their signatures
- Data to gather from users
- Workflow steps

**Example:**

```
Use case: "A customer support agent that helps users track orders,
process returns, and answer product questions. Should escalate
complex issues to human agents."

Output:
- Topology: supervisor (routes between specialized agents)
- Agents: Order_Tracker, Returns_Handler, Product_FAQ, Human_Escalation
- Tools: lookup_order, initiate_return, search_products
- Gather: order_id, customer_email, issue_type
```

### `kore_architect_gaps`

Detects ABL limitations that may affect your use case and suggests alternatives.

**Input:**

- `use_case`: The use case description
- `format`: Optional - `agent-platform` or `xo11` if importing

**Output:**

- List of gaps with severity (minor, moderate, significant)
- Alternative approaches for each gap
- Overall coverage percentage
- DSL patterns to work around limitations

**Example Gaps:**

| Gap                  | Severity | Alternative                                |
| -------------------- | -------- | ------------------------------------------ |
| No loop constructs   | moderate | Use recursive FLOW steps or reasoning mode |
| No HTTP call syntax  | minor    | Wrap API calls in TOOLS                    |
| No file upload       | moderate | Define upload TOOL that returns metadata   |
| No timers/scheduling | moderate | Use external scheduler + ON_START pattern  |

### `kore_architect_generate`

Generates ABL code from an architecture specification.

**Input:**

- `architecture`: The architecture spec from analyze
- `topology`: `single-agent`, `supervisor`, or `adaptive-network`
- `include_comments`: Whether to add explanatory comments

**Output:**

- Complete ABL files for each agent
- Supervisor definition (if multi-agent)
- Tool stubs with signatures

### `kore_architect_scaffold`

Creates a complete project directory with ABL files and documentation.

**Input:**

- `project_name`: Name for the project directory
- `architecture`: The architecture specification
- `output_dir`: Where to create the project

**Output:**
Creates:

```
my_project/
├── agents/
│   ├── supervisor.agent.abl
│   ├── order_tracker.agent.abl
│   └── returns_handler.agent.abl
├── docs/
│   ├── README.md
│   ├── ARCHITECTURE.md
│   └── DEPLOYMENT.md
└── tools/
    └── tools_impl.py  (stub implementations)
```

### `kore_validate_abl`

Validates ABL files for syntax and structural correctness.

**Input:**

- `path`: File or directory path to validate

**Output:**

- List of errors with line numbers
- List of warnings
- Overall valid/invalid status

## Gap Analysis Deep Dive

### Understanding Gap Reports

When you run gap analysis, you get a report like:

```
Gap Report for: Customer Support Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall Coverage: 85%

Gaps Found (2):
┌─────────────────────────────────────────────────────────────┐
│ 1. Loop/Iteration Constructs                                │
│    Severity: moderate (-8%)                                 │
│    Your use case mentions: "iterate through order items"    │
│                                                             │
│    ABL Limitation:                                          │
│    ABL has no native loop or iteration syntax               │
│                                                             │
│    Alternatives:                                            │
│    A) Use recursive FLOW step patterns                      │
│       FLOW:                                                 │
│         process_item -> check_more                          │
│         process_item:                                       │
│           CALL: process_next_item                           │
│           THEN: check_more                                  │
│         check_more:                                         │
│           ON_INPUT:                                         │
│             - IF: has_more_items == true                    │
│               THEN: process_item                            │
│                                                             │
│    B) Use reasoning mode - LLM decides when to repeat       │
│       # No FLOW → reasoning-only                                       │
└─────────────────────────────────────────────────────────────┘
```

### Coverage Calculation

Coverage is calculated based on gap severities:

- **Minor gaps**: -3% each (easily worked around)
- **Moderate gaps**: -8% each (requires design changes)
- **Significant gaps**: -15% each (major functionality limitations)

Coverage = 100% - sum(gap_weights)

### Known ABL Gaps

| Gap ID                      | Description                                 | Severity |
| --------------------------- | ------------------------------------------- | -------- |
| `no-http-calls`             | No native HTTP/API call syntax              | minor    |
| `no-loops`                  | No iteration constructs                     | moderate |
| `no-timers`                 | No scheduling/timer triggers                | moderate |
| `no-database`               | No direct database access                   | minor    |
| `no-conditional-gather`     | Can't show/hide GATHER fields conditionally | moderate |
| `no-file-upload`            | No file handling syntax                     | moderate |
| `no-multi-turn-tools`       | Tools are synchronous only                  | moderate |
| `no-streaming`              | No real-time streaming responses            | minor    |
| `no-arithmetic`             | No math in conditions                       | minor    |
| `limited-entity-extraction` | Relies on LLM for extraction                | minor    |
| `no-multi-language`         | No built-in i18n                            | moderate |

### Agent Platform v12 Specific Gaps

When importing from Agent Platform v12:

| Gap ID                 | Description                    | Severity    |
| ---------------------- | ------------------------------ | ----------- |
| `ap-processors`        | JavaScript pre/post processors | significant |
| `ap-voice`             | Real-time voice/VAD config     | moderate    |
| `ap-thought-streaming` | Thought streaming to UI        | minor       |
| `ap-pii-masking`       | Built-in PII detection         | moderate    |
| `ap-per-agent-model`   | Per-agent model configuration  | moderate    |
| `ap-content-variables` | Template variable system       | minor       |
| `ap-model-retry`       | Model fallback configuration   | minor       |
| `ap-channel-branching` | Channel-specific flows         | moderate    |

### XO11 Specific Gaps

When importing from XO11:

| Gap ID              | Description                          | Severity    |
| ------------------- | ------------------------------------ | ----------- |
| `xo11-script-nodes` | Custom JavaScript logic              | significant |
| `xo11-channel-ux`   | Rich cards, carousels, quick replies | moderate    |

## Topologies

### Single Agent

Best for: Simple, focused tasks with one domain.

```
AGENT: Support_Agent
# No FLOW section → reasoning-only execution
GOAL: "Help customers with questions"

TOOLS:
  search_faq(query: string) -> {answer: string}

GATHER:
  question:
    type: string
    prompt: "What can I help you with?"
```

### Supervisor (Multi-Agent)

Best for: Complex domains requiring specialization.

```
SUPERVISOR: Main_Router
# No FLOW section → reasoning-only execution
GOAL: "Route customers to the right specialist"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent == "purchase"
    CONTEXT:
      pass: [customer_id]
      summary: "Customer interested in buying"

  - TO: Support_Agent
    WHEN: intent == "support"
    CONTEXT:
      pass: [order_id]
      summary: "Customer needs help"
```

### Adaptive Network

Best for: Peer agents that delegate to each other.

```
AGENT: Order_Agent
# No FLOW section → reasoning-only execution
GOAL: "Handle order-related requests"

DELEGATE:
  - AGENT: Payment_Agent
    WHEN: needs_payment_processing == true
    PURPOSE: "Process payment for order"
    INPUT: {order_id: order_id, amount: total}
    RETURNS: {transaction_id: string}
```

## Example Workflow

### 1. Start with a Use Case

```
"Build a hotel booking assistant that helps users search for hotels,
make reservations, and manage existing bookings. Users should be able
to specify dates, location, number of guests, and preferences like
pet-friendly or pool access."
```

### 2. Analyze the Use Case

The analyze tool identifies:

- **Topology**: Single agent (focused domain)
- **Tools**: search_hotels, create_booking, get_booking, cancel_booking
- **Gather fields**: check_in_date, check_out_date, location, guests, preferences
- **Constraints**: Dates must be in the future, guests must be positive

### 3. Check for Gaps

Gap analysis finds:

- No significant gaps for this use case
- Minor gap: No arithmetic (can't calculate total nights inline)
- Coverage: 97%

### 4. Generate ABL

```abl
AGENT: Hotel_Booking_Agent
# No FLOW section → reasoning-only execution
GOAL: "Help users search for and book hotels"

PERSONA: |
  You are a helpful hotel booking assistant.
  Be friendly and help users find the perfect accommodation.

TOOLS:
  search_hotels(location: string, check_in: string, check_out: string, guests: number) -> {hotels: object[]}
  create_booking(hotel_id: string, guest_info: object) -> {confirmation: string}
  get_booking(confirmation: string) -> {booking: object}
  cancel_booking(confirmation: string) -> {success: boolean}

GATHER:
  location:
    type: string
    prompt: "Where would you like to stay?"
  check_in_date:
    type: date
    prompt: "When do you want to check in?"
  check_out_date:
    type: date
    prompt: "When do you want to check out?"
  guests:
    type: number
    prompt: "How many guests?"
  preferences:
    type: string
    optional: true
    prompt: "Any preferences? (pet-friendly, pool, etc.)"

CONSTRAINTS:
  booking_requirements:
    - REQUIRE check_in_date IS SET
    - REQUIRE check_out_date IS SET
    - REQUIRE location IS SET

COMPLETE:
  WHEN: booking_confirmed == true
  RESPOND: "Your booking is confirmed! Confirmation: {{confirmation_number}}"
```

### 5. Scaffold Project

Creates a ready-to-use project structure with documentation.

### 6. Validate

Validates all generated ABL files for syntax errors.

## Best Practices

1. **Start with gap analysis** - Understand limitations before designing
2. **Choose the right topology** - Don't over-engineer simple use cases
3. **Use reasoning mode** for open-ended tasks, scripted for forms
4. **Define clear tool boundaries** - Each tool should do one thing well
5. **Validate early and often** - Catch syntax errors before runtime
6. **Document alternatives** - When gaps exist, document workarounds

## Troubleshooting

### "Unknown import format"

The import analyzer couldn't detect the format. Ensure your JSON has:

- **Agent Platform v12**: `app`, `MCPServers`, `agents` fields
- **XO11**: `dialogFlows` or `dialogTasks` fields

### "Gap coverage too low"

If coverage is below 70%, consider:

1. Simplifying the use case
2. Moving complex logic to external tools
3. Using a hybrid approach with external systems

### "Validation errors"

Common issues:

- Missing `AGENT:` or `SUPERVISOR:` declaration
- `MODE:` is deprecated (execution style derived from FLOW presence)
- Tool definitions missing `->` return type
