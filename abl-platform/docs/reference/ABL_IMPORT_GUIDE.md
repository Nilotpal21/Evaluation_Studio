# ABL Import Guide

This guide explains how to import and convert existing Kore.ai bot definitions to ABL (Agent Blueprint Language).

## Supported Formats

| Format                 | Description                            | Detection                                                            |
| ---------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| **Agent Platform v12** | Modern Kore.ai format with MCP servers | Has `app`, `MCPServers`, `agents`                                    |
| **XO11**               | Legacy dialog task format              | Has `dialogFlows` or `dialogTasks`                                   |
| **YAML**               | ABL YAML format (`.agent.yaml`)        | Has `agent:` or `supervisor:` top-level keys with lowercase keywords |

## Quick Start

### Using MCP Tools (Claude Code)

```
"Import this Agent Platform export and convert to ABL"
[paste or attach JSON export]
```

The tools will:

1. Auto-detect the format
2. Analyze the structure
3. Generate gap report
4. Create ABL files

### Using CLI

```bash
# Analyze an export file
kore-platform-cli import analyze ./export.json

# Convert to ABL
kore-platform-cli import convert ./export.json -o ./output/
```

If you edited an exported v2 project folder by hand before importing it, repair the local `abl.lock` first:

```bash
kore-platform-cli lockfile recompute ./output/
kore-platform-cli lockfile recompute ./output/ --check
```

This recomputes per-file hashes, layer hashes, and root integrity from the current files on disk. It is the supported path for stale or `null` v2 hash fields; avoid editing lockfile hashes manually.

## Import Workflow

```
┌─────────────────────┐
│   Export JSON       │
│   (from Kore.ai)    │
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│   Format Detection  │  ← agent-platform or xo11
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│   Import Analysis   │  ← Extract entities, map to ABL
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│   Gap Detection     │  ← Identify unsupported features
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│   ABL Generation    │  ← Create .agent.abl files
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│   Validation        │  ← Verify generated files
└─────────────────────┘
```

## Agent Platform v12 Import

### What Gets Imported

| Source                    | Target               | Notes                          |
| ------------------------- | -------------------- | ------------------------------ |
| `agents[]`                | `AGENT:` definitions | Each agent becomes an ABL file |
| `app.orchestrationPrompt` | `SUPERVISOR:`        | Custom routing logic           |
| `MCPServers[].tools[]`    | `TOOLS:` section     | Tool signatures preserved      |
| `app.memoryStores[]`      | `MEMORY:` section    | Persistence paths              |
| Agent `subType`           | Metadata             | Noted in comments              |

### Example: Agent Platform Export

**Input (export.json):**

```json
{
  "app": {
    "orchestrationPrompt": {
      "custom": "Route based on user intent. Sales inquiries go to Sales_Agent, support issues go to Support_Agent."
    },
    "memoryStores": [{ "memoryStoreName": "user_preferences" }]
  },
  "MCPServers": [
    {
      "name": "CRMServer",
      "tools": [
        {
          "name": "lookup_customer",
          "description": "Find customer by email or ID",
          "inputSchema": {
            "type": "object",
            "properties": {
              "email": { "type": "string" },
              "customer_id": { "type": "string" }
            }
          }
        }
      ]
    }
  ],
  "agents": [
    {
      "name": "Sales_Agent",
      "subType": "sales",
      "instructions": "Help customers with purchases"
    },
    {
      "name": "Support_Agent",
      "subType": "support",
      "instructions": "Help customers with issues"
    }
  ]
}
```

**Output (supervisor.agent.abl):**

```abl
SUPERVISOR: Main_Supervisor
# No FLOW section → reasoning-only execution
GOAL: "Route based on user intent. Sales inquiries go to Sales_Agent, support issues go to Support_Agent."

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent == "sales"
    CONTEXT:
      pass: [customer_id]
      summary: "Sales inquiry"

  - TO: Support_Agent
    WHEN: intent == "support"
    CONTEXT:
      pass: [customer_id, order_id]
      summary: "Support request"
```

**Output (sales_agent.agent.abl):**

```abl
AGENT: Sales_Agent
# No FLOW section → reasoning-only execution
GOAL: "Help customers with purchases"

# Imported from Agent Platform v12 (subType: sales)

TOOLS:
  lookup_customer(email: string, customer_id: string) -> {customer: object}

MEMORY:
  persistent:
    - user_preferences
```

### Agent Platform Gaps

Features that require manual intervention:

| Feature               | Gap                    | Action Required                 |
| --------------------- | ---------------------- | ------------------------------- |
| JavaScript processors | `ap-processors`        | Reimplement as TOOLS            |
| Voice/VAD config      | `ap-voice`             | Configure at platform level     |
| PII masking           | `ap-pii-masking`       | Add GUARDRAILS or external tool |
| Per-agent models      | `ap-per-agent-model`   | Configure at deployment         |
| Content variables     | `ap-content-variables` | Use MEMORY persistent paths     |

## XO11 Import

### What Gets Imported

| Source                 | Target               | Notes                      |
| ---------------------- | -------------------- | -------------------------- |
| `dialogFlows[]`        | `AGENT:` definitions | Each flow becomes an agent |
| `dialogFlows[].intent` | Routing conditions   | Used in HANDOFF WHEN       |
| Webhook nodes          | `TOOLS:`             | API calls preserved        |
| Entity nodes           | `GATHER:` fields     | Prompts and types mapped   |
| Message nodes          | `FLOW:` steps        | RESPOND actions            |
| Script nodes           | `TOOLS:` (GAP)       | Must be reimplemented      |

### Example: XO11 Export

**Input (xo11-export.json):**

```json
{
  "dialogFlows": [
    {
      "name": "BookAppointment",
      "intent": "book_appointment",
      "nodes": [
        {
          "name": "welcome_message",
          "type": "message",
          "message": "I'd be happy to help you book an appointment!"
        },
        {
          "name": "get_date",
          "type": "entity",
          "prompt": "What date works for you?",
          "entityType": "date"
        },
        {
          "name": "get_time",
          "type": "entity",
          "prompt": "What time would you prefer?",
          "entityType": "time"
        },
        {
          "name": "confirm_booking",
          "type": "webhook",
          "url": "https://api.example.com/book",
          "method": "POST"
        }
      ]
    }
  ],
  "scriptNodes": [
    {
      "name": "format_datetime",
      "script": "return date + ' ' + time;"
    }
  ]
}
```

**Output (book_appointment.agent.abl):**

```abl
AGENT: Book_Appointment
# Has FLOW section → flow-based execution
GOAL: "Help users book appointments"

# Imported from XO11 (intent: book_appointment)

TOOLS:
  confirm_booking(date: string, time: string) -> {confirmation: object}
  # GAP: format_datetime script node must be reimplemented
  format_datetime(date: string, time: string) -> {formatted: string}

GATHER:
  date:
    type: date
    prompt: "What date works for you?"
  time:
    type: time
    prompt: "What time would you prefer?"

FLOW:
  welcome -> get_date -> get_time -> confirm

  welcome:
    RESPOND: "I'd be happy to help you book an appointment!"
    THEN: get_date

  get_date:
    GATHER: date
    THEN: get_time

  get_time:
    GATHER: time
    THEN: confirm

  confirm:
    CALL: confirm_booking
    ON_SUCCESS:
      RESPOND: "Your appointment is confirmed!"
    ON_ERROR:
      RESPOND: "Sorry, there was an issue booking. Let me try again."
      RETRY: 1
```

### XO11 Gaps

| Feature       | Gap                 | Action Required                               |
| ------------- | ------------------- | --------------------------------------------- |
| Script nodes  | `xo11-script-nodes` | Rewrite as TOOLS with external implementation |
| Carousels     | `xo11-channel-ux`   | Use structured text responses                 |
| Quick replies | `xo11-channel-ux`   | Platform renders options from text            |
| Rich cards    | `xo11-channel-ux`   | Use markdown-style formatting                 |

## YAML Format Import

### Overview

ABL now supports a YAML-based format (`.agent.yaml`) alongside the traditional `.agent.abl` format. YAML files use lowercase keywords exclusively and are auto-detected by the import pipeline.

### Detection

The importer detects YAML format when:

- File extension is `.yaml` or `.yml`
- Content starts with `agent:` or `supervisor:` (lowercase)
- Content passes `isYamlFormat()` validation

### Example: YAML Agent

```yaml
agent: Hotel_Search

goal: "Help user find and book a hotel"

persona: |
  Friendly hotel booking specialist.

tools:
  search_hotels(destination: string, checkin: date) -> Hotel[]

gather:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true

flow:
  welcome -> search -> confirm

  welcome:
    respond: "Welcome! Let me help you find a hotel."
    then: search

  search:
    call: search_hotels(destination, checkin)
    then: confirm
```

### Round-Trip Support

The export pipeline supports YAML output via `serializeToYAML()`:

- `kore-platform-cli export --format yaml` outputs `.agent.yaml` files
- Keywords are always lowercase in YAML format
- Import -> Export -> Import round-trip is lossless (case-insensitive keyword matching)

### CLI Commands

```bash
# Import YAML files
kore-platform-cli import convert ./agents/ -o ./output/

# Export as YAML
kore-platform-cli export --format yaml ./project/ -o ./output/

# Validate YAML agents
kore-platform-cli validate ./agents/*.yaml
```

## Entity Mapping

### Name Conversions

| Source Name     | ABL Agent Name  | ABL Tool Name   |
| --------------- | --------------- | --------------- |
| `myAgent`       | `My_Agent`      | `my_agent`      |
| `SalesBot`      | `Sales_Bot`     | `sales_bot`     |
| `order-handler` | `Order_Handler` | `order_handler` |
| `API Call 1`    | `Api_Call_1`    | `api_call_1`    |

### Type Mappings

| Source Type         | ABL Type   |
| ------------------- | ---------- |
| `string`            | `string`   |
| `number`, `integer` | `number`   |
| `boolean`           | `boolean`  |
| `date`, `datetime`  | `date`     |
| `object`, `json`    | `object`   |
| `array`             | `object[]` |

## Post-Import Checklist

After importing, verify and complete these items:

### 1. Review Gap Report

- [ ] Understand each identified gap
- [ ] Plan alternatives for significant gaps
- [ ] Document workarounds

### 2. Implement Tool Stubs

- [ ] Script nodes → External tool functions
- [ ] Webhook nodes → API wrapper tools
- [ ] Custom logic → New tool implementations

### 3. Verify GATHER Fields

- [ ] Prompts are user-friendly
- [ ] Types match expected input
- [ ] Validation rules are appropriate

### 4. Test Routing Logic

- [ ] HANDOFF conditions are correct
- [ ] WHEN expressions use valid fields
- [ ] Context passing includes needed data

### 5. Add Missing Sections

- [ ] PERSONA for tone/style
- [ ] LIMITATIONS for guardrails
- [ ] ESCALATE for human handoff
- [ ] ON_ERROR for failure handling

### 6. Validate All Files

```bash
kore-platform-cli validate ./output/
```

## Troubleshooting

### "Unknown import format"

**Problem:** The analyzer can't detect the format.

**Solutions:**

1. Check that JSON is valid (use `jq .` to validate)
2. Verify required fields exist:
   - Agent Platform: `app`, `MCPServers`, `agents`
   - XO11: `dialogFlows` or `dialogTasks`
3. Check for typos in field names

### "Script nodes detected"

**Problem:** XO11 script nodes can't be directly converted.

**Solution:**

1. Review each script node's logic
2. Create equivalent TOOLS with external implementations
3. Update FLOW to use the new tools

Example:

```javascript
// Original XO11 script
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

```abl
# ABL tool definition
TOOLS:
  calculate_total(items: object[]) -> {total: number}
```

```python
# External implementation (tools_impl.py)
def calculate_total(items: list) -> dict:
    total = sum(item['price'] for item in items)
    return {'total': total}
```

### "Multiple dialog flows found"

**Problem:** XO11 has multiple flows, unclear how to organize.

**Solution:**

1. Each flow becomes a separate agent
2. Create a supervisor to route between them
3. Use intent/keywords for routing conditions

### "Missing tool schemas"

**Problem:** Webhook nodes don't have full input/output schemas.

**Solution:**

1. Check API documentation for the webhooks
2. Define appropriate parameter types
3. Add return type based on expected response

### "Memory stores not mapped"

**Problem:** Complex memory configurations need manual mapping.

**Solution:**

1. Review memory store purposes
2. Add to MEMORY section with appropriate persistence
3. Reference in GATHER or CONSTRAINTS as needed

## Best Practices

1. **Import incrementally** - Start with one agent, verify, then continue
2. **Keep original export** - Useful for reference during conversion
3. **Test early** - Run validation after each major change
4. **Document changes** - Note what was modified from original
5. **Review routing** - Supervisor HANDOFF logic is critical
6. **Simplify where possible** - ABL may enable simpler designs
