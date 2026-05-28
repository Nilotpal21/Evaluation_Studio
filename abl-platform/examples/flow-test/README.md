# Flow Test - Hotel Booking (Consolidated)

A comprehensive example demonstrating all ABL flow patterns through a hotel booking scenario. This single agent consolidates patterns from 8 previous variant files into one best-practice reference.

## Flow Patterns Demonstrated

### Core Flow

- **FLOW steps** - 12-step linear flow with conditional branching
- **THEN** - Step transitions (including THEN: COMPLETE)
- **REASONING: false** - Disabling reasoning for deterministic steps

### Data Collection

- **GATHER** - Entity collection with required fields, types, and prompts
- **STRATEGY: llm** - LLM-based entity extraction from natural language
- **CORRECTIONS: true** - Allowing users to correct previously gathered values
- **COMPLETE_WHEN** - Conditional step completion

### Navigation & Branching

- **ON_INPUT** - Conditional branching based on user input
- **Back navigation** - "back" returns to previous step
- **Start over** - "start over" restarts from welcome
- **Change [field]** - Jump to specific steps to modify values

### Tool Calls

- **CALL** - Invoking tools with parameters
- **ON_SUCCESS / ON_FAIL** - Handling tool call results
- **ON_RESULT** - Processing tool results with SET

### Variable Management

- **SET** - Setting context variables
- **CLEAR** - Clearing variables to re-gather them

### Constraints

- **REQUIRE** - Runtime constraint enforcement
- **ON_FAIL** - Constraint violation handling (RESPOND, ESCALATE)
- **CHECK** - Step-level constraint validation

### Delegation

- **DELEGATE** - Sub-agent invocation with INPUT/RETURNS mapping
- **USE_RESULT** - Capturing delegation results
- **TIMEOUT** - Delegation timeout handling

### Conversation Management

- **DIGRESSIONS** - Out-of-scope handling with RESUME
- **global_digressions** - Flow-wide digression handlers
- **SUB_INTENTS** - In-step intent handling
- **PROMPT** - Custom step prompts
- **PRESENT** - Rich data presentation

### Output Formatting

- **FORMATS** - Multi-format output (MARKDOWN, HTML)
- **VOICE** - Voice channel instructions
- **STORE** - Persisting completed results

## Project Structure

```
flow-test/
  project.json              # v2 export manifest
  agents/
    hotel_booking.agent.abl # Consolidated best example
  config/
    project-settings.json
  environment/
    env-vars.json
  locales/
    en/
      hotel_booking.json
```

## Running

Import this project using the ABL project import:

```bash
abl project import ./examples/flow-test/
```

## Consolidation Notes

This agent consolidates patterns from 8 previous variants:

- `hotel_booking_flow.agent.abl` - Basic linear flow
- `simple_booking.agent.abl` - FORMATS and VOICE patterns
- `hotel_booking_enhanced.agent.abl` - DIGRESSIONS, SUB_INTENTS, CORRECTIONS, CLEAR
- `booking_with_constraints.agent.abl` - CONSTRAINTS, DELEGATE, STORE, CHECK
- `hotel_booking_advanced.agent.abl` - ON_INPUT, SET, navigation, conditional branching
- `on_input_test.agent.abl` - ON_INPUT conditional testing
- `price_calculator.agent.abl` - Sub-agent delegation
- `simple_constraint_test.agent.abl` - Basic constraint patterns
