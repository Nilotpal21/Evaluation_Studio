# ABL Language Basics

> **Estimated time**: 25 minutes | **Prerequisites**: Getting Started module, Core Concepts module

## Learning Objectives

After completing this module, you will be able to:

- Write a complete agent definition with the required AGENT and GOAL sections
- Use the correct file extensions (`.agent.abl`, `.tools.abl`) and understand when to use each
- Create shared tool files and import them into agents using `FROM...USE` syntax
- Apply ABL syntax rules including case-insensitive uppercase keywords, indentation, and string formats
- Use `{{variable}}` template interpolation in agent responses

## ABL at a Glance

ABL (Agent Behavior Language) is a declarative DSL for defining AI agents, their tools, data collection, and execution flows. A complete agent can be defined in as few as 12 lines:

```abl
AGENT: Customer_Support

GOAL: |
  Help customers resolve billing questions.

TOOLS:
  lookup_account(account_id: string) -> {name: string, balance: number}
    description: "Retrieve account details"

GATHER:
  account_id:
    prompt: "What is your account number?"
    type: string
    required: true
```

This definition creates a support agent with a tool and a data collection field. ABL handles the rest: LLM orchestration, session management, and response delivery.

## Required Sections: AGENT and GOAL

Every ABL agent document must contain two sections -- no exceptions:

### The AGENT Section

The `AGENT:` keyword declares the agent's unique name within the project:

```abl
AGENT: Wire_Transfer_Specialist
```

Naming rules:

- Use `PascalCase` with underscores to separate words
- Must start with a letter
- May contain letters, digits, and underscores
- Must be unique within the project

```abl
AGENT: Hotel_Search
AGENT: Payment_Processor
AGENT: Customer_Support
AGENT: Fraud_Detection
```

### The GOAL Section

The `GOAL:` section defines the agent's primary objective. It drives the LLM's reasoning, determines completion conditions, and provides the core purpose statement included in every system prompt.

Single-line format:

```abl
GOAL: "Process the customer's wire transfer request accurately and securely."
```

Multi-line format using the pipe block:

```abl
GOAL: |
  Process the customer's outbound wire transfer request accurately and
  securely. Collect all required beneficiary and payment details, screen
  for sanctions and fraud, enforce daily limits and cut-off windows,
  and execute the transfer with a complete audit trail.
```

> **Key Concept**: AGENT and GOAL are the only required sections. Every other section (PERSONA, TOOLS, FLOW, EXECUTION, etc.) is optional. If a section is omitted, it defaults to empty or platform defaults. This means the simplest valid agent is just two lines: `AGENT: My_Agent` and `GOAL: "Do something"`.

## File Extensions

ABL uses specific file extensions to distinguish different types of documents:

| Extension     | Contents                        | When to Use                                  |
| ------------- | ------------------------------- | -------------------------------------------- |
| `.agent.abl`  | Agent definition                | Most common -- one file per agent            |
| `.tools.abl`  | Reusable tool library           | When multiple agents share the same tools    |
| `.agent.yaml` | Agent definition in YAML format | Alternative format for teams preferring YAML |

> **Key Concept**: The `.agent.abl` extension is the standard for agent definitions. The `.tools.abl` extension is specifically for shared tool files that can be imported by multiple agents. This separation promotes reuse -- define a tool library once, import it everywhere.

## ABL Syntax Rules

### Keywords Are Case-Insensitive but Uppercase by Convention

Section keywords are uppercase by convention and followed by a colon. At the parser level, they are case-insensitive -- `AGENT:`, `agent:`, and `Agent:` all parse identically. However, **uppercase is the canonical style** and should always be used for consistency.

```abl
# All three parse identically, but uppercase is the standard:
AGENT: My_Agent      # Correct -- canonical style
agent: My_Agent      # Works but not recommended
Agent: My_Agent      # Works but not recommended
```

> **Key Concept**: Keywords are case-insensitive at the parser level, but uppercase is the canonical ABL style. Always write `AGENT:`, `GOAL:`, `TOOLS:`, `FLOW:`, etc. in uppercase for consistency with the ABL community and documentation.

### Indentation

ABL uses indentation to express nesting, similar to YAML. Use spaces (two or more) for indentation. Content nested under a section keyword must be indented further than the keyword line:

```abl
TOOLS:
  search(query: string) -> {results: string[]}
    description: "Search the catalog"
    type: http
    endpoint: "/api/search"
    method: GET
```

### Comments

Lines beginning with `#` are comments and ignored by the parser:

```abl
# This agent handles billing questions
AGENT: Billing_Support

GOAL: "Help customers resolve billing inquiries"
```

Note: Inline comments (after code on the same line) are NOT supported in ABL format.

### Strings

Strings can be written in three forms:

| Form       | Syntax                          | Use Case                                 |
| ---------- | ------------------------------- | ---------------------------------------- |
| Quoted     | `"value"`                       | Single-line values                       |
| Unquoted   | `value`                         | Simple values without special characters |
| Pipe block | `\|` followed by indented lines | Multi-line text (preserves newlines)     |

```abl
GOAL: "Single line goal"

GOAL: |
  Multi-line goal that preserves
  line breaks within the block.

LANGUAGE: "en"
```

### Lists

Lists use YAML-style `- item` syntax:

```abl
LIMITATIONS:
  - "Cannot access external systems"
  - "Cannot process payments directly"
```

## All Recognized Sections

While only AGENT and GOAL are required, ABL recognizes many optional sections. Here are the most commonly used:

| Section         | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `AGENT:`        | Agent name declaration (required)                                          |
| `GOAL:`         | Agent objective (required)                                                 |
| `PERSONA:`      | Agent personality and communication style                                  |
| `LIMITATIONS:`  | Explicit boundaries the agent must respect                                 |
| `INSTRUCTIONS:` | Operational guidance supplementing the goal                                |
| `EXECUTION:`    | Model and runtime configuration                                            |
| `IDENTITY:`     | Combined identity block (alternative to separate GOAL/PERSONA/LIMITATIONS) |
| `TOOLS:`        | Tool definitions and imports                                               |
| `GATHER:`       | Information collection fields                                              |
| `FLOW:`         | Structured execution steps                                                 |
| `MEMORY:`       | Session and persistent state                                               |
| `CONSTRAINTS:`  | Business rule enforcement                                                  |
| `GUARDRAILS:`   | Input/output safety checks                                                 |
| `HANDOFF:`      | Agent transfer rules                                                       |
| `DELEGATE:`     | Sub-agent delegation                                                       |
| `ESCALATE:`     | Human escalation triggers                                                  |
| `COMPLETE:`     | Completion conditions                                                      |
| `ON_ERROR:`     | Error handlers                                                             |
| `ON_START:`     | Session initialization                                                     |
| `TEMPLATES:`    | Reusable response templates                                                |

## Defining Tools

Tools give agents the ability to interact with external systems. You define tool signatures (name, parameters, return type) in the TOOLS section:

```abl
TOOLS:
  search_hotels(destination: string, checkin: date, checkout: date, guests: number) -> {hotels: array}
    description: "Search for available hotels by destination and dates"

  get_hotel_details(hotel_id: string) -> {name: string, rating: number, amenities: array}
    description: "Get detailed information about a specific hotel"
```

Each tool declaration specifies:

- **Name** with parameters and their types
- **Return type** after the `->` arrow
- **Description** explaining what the tool does (helps the LLM decide when to use it)

### Tool Execution Types

ABL supports four tool execution types:

| Type              | Description                                               |
| ----------------- | --------------------------------------------------------- |
| **http**          | REST API calls with configurable auth, headers, and retry |
| **mcp**           | Calls to an MCP server via the Model Context Protocol     |
| **sandbox**       | User-uploaded code running in an isolated runtime         |
| **contract-only** | Implementation injected by the Runtime at deployment      |

## Shared Tool Files with FROM...USE

When multiple agents need the same tools, define them in a shared `.tools.abl` file. This avoids duplication and keeps tool configurations consistent.

### Creating a Tool File

Create `tools/hotels-api.tools.abl`:

```abl
TOOLS:
  base_url: "https://api.hotels.example.com/v1"
  auth: bearer
  timeout: 5000
  retry: 3

  search_hotels(destination: string, checkin: date, checkout: date) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST
    description: "Search available hotels"

  get_hotel(hotel_id: string) -> Hotel
    type: http
    endpoint: "/hotels/{hotel_id}"
    method: GET
    description: "Get hotel details by ID"

  get_reviews(hotel_id: string, limit: number = 10) -> Review[]
    type: http
    endpoint: "/hotels/{hotel_id}/reviews"
    method: GET
    description: "Get reviews for a hotel"
```

File-level settings (`base_url`, `auth`, `timeout`, `retry`) apply to every tool in the file.

### Importing Tools with FROM...USE

In your agent definition, import specific tools from the shared file:

```abl
AGENT: Travel_Assistant

GOAL: |
  Help users find hotels and plan their trips.

TOOLS:
  FROM "./tools/hotels-api.tools.abl" USE: search_hotels, get_hotel

  get_weather(location: string) -> {temp: number, conditions: string}
    type: mcp
    server: "weather-service"
    tool: "get_current_weather"
    description: "Get current weather for a destination"
```

> **Key Concept**: The `FROM...USE` syntax imports specific tools from a shared `.tools.abl` file. This is how ABL promotes reuse -- define tools once in a shared file, import them into any agent that needs them. You can mix imported tools with inline tool definitions in the same TOOLS section.

## Template Interpolation with {{variables}}

Throughout ABL, string values support template interpolation using double-brace syntax. Templates are resolved **at runtime** against session variables and tool results.

### Basic Variable Interpolation

```abl
RESPOND: "Hello, {{customer_name}}. Your balance is {{balance}}."
```

When the Runtime reaches this RESPOND, it replaces `{{customer_name}}` and `{{balance}}` with their current values from the session state.

### Conditional Blocks

Handlebars-style helpers support conditional rendering:

```abl
RESPOND: "{{#if exchange_rate}}Rate: {{exchange_rate}}{{/if}}"
```

### Iterating Over Arrays

Use `{{#each}}` to iterate over tool results:

```abl
RESPOND: |
  Found {{hotels.length}} hotels in {{destination}}:

  {{#each hotels}}
  {{add @index 1}}. {{name}} - ${{price}}/night ({{rating}} stars)
  {{/each}}

  Which hotel would you like to book?
```

> **Key Concept**: Template interpolation uses `{{variable}}` double-brace syntax and is resolved at runtime, not at compile time. This means you can reference session variables, GATHER field values, and tool results in any RESPOND message or template string. The platform uses Handlebars-style helpers for conditionals (`{{#if}}`), iteration (`{{#each}}`), and expressions.

## Document Type Auto-Detection

The parser determines the document type from the first meaningful keyword:

| First Keyword                            | Document Type             |
| ---------------------------------------- | ------------------------- |
| `AGENT:`                                 | Agent document            |
| `SUPERVISOR:`                            | Supervisor document       |
| `BEHAVIOR_PROFILE:`                      | Behavior profile document |
| `TOOLS:` (at root level in `.tools.abl`) | Tool file document        |

You do not need to declare the document type explicitly -- the parser infers it.

## Building a Complete Agent: Step by Step

Let us build a complete agent from scratch, applying everything covered in this module:

```abl
# Bean & Brew Coffee Shop Assistant
# File: greeter.agent.abl

AGENT: Customer_Greeter

EXECUTION:
  model: claude-sonnet-4-5-20250929

GOAL: |
  Welcome visitors to Bean & Brew coffee shop. Answer questions about
  the menu, store hours, and location. Keep responses friendly, concise,
  and on-topic.

PERSONA: |
  Warm, friendly barista named Alex who has worked at Bean & Brew
  for three years. Loves recommending the house blend and seasonal
  specials. Keeps answers short and helpful.

LIMITATIONS:
  - "Cannot process orders or payments"
  - "Cannot access real-time inventory"
  - "Cannot make reservations"

INSTRUCTIONS: |
  1. Greet the customer warmly when they first message
  2. Answer questions about the menu, hours, or location
  3. If asked about placing an order, explain that online ordering
     is coming soon and suggest visiting the store
  4. Keep responses under 3 sentences when possible

COMPLETE:
  - WHEN: user.says_goodbye == true
    RESPOND: "Thanks for stopping by Bean & Brew! See you next time."
```

This agent demonstrates:

- **Required sections**: AGENT and GOAL
- **Optional identity**: PERSONA and LIMITATIONS shape behavior
- **Execution config**: Specifying the LLM model
- **Instructions**: Numbered operational guidance
- **Completion**: Defining when the session ends
- **File naming**: `greeter.agent.abl`

## Key Takeaways

- Every agent requires exactly two sections: **AGENT** (unique name) and **GOAL** (primary objective) -- all other sections are optional
- Agent files use the **`.agent.abl`** extension; shared tool libraries use **`.tools.abl`**
- **`FROM...USE`** imports specific tools from shared tool files, promoting reuse across agents
- Keywords are **case-insensitive** but **uppercase is the canonical style** (AGENT, GOAL, TOOLS, FLOW)
- **`{{variable}}`** template interpolation is resolved at runtime against session variables and tool results

## What's Next

Move to the **Agent Configuration** module to learn about advanced execution settings, the IDENTITY block, per-operation model routing, and error handling with ON_ERROR.
