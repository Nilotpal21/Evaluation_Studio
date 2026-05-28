# Conversation Flows

> **Estimated time**: 30 minutes | **Prerequisites**: ABL Basics module, Agent Configuration module

## Learning Objectives

After completing this module, you will be able to:

- Build structured conversation flows using FLOW with named steps and transitions
- Use ON_INPUT with IF/ELSE branches to validate and route based on user input
- End sessions with `THEN: COMPLETE` and understand completion conditions
- Enable LLM autonomy within specific steps using `REASONING: true`
- Handle tool results with ON_SUCCESS and ON_FAIL branching
- Collect structured data from users using GATHER within flow steps

## Why Use Flows?

Every agent in ABL reasons by default -- the LLM decides what to do based on the GOAL, PERSONA, and INSTRUCTIONS. This works well for open-ended conversations where the path is unpredictable. But many real-world processes need structure: a booking must collect destination, dates, and payment in order. A loan application must follow regulatory steps. An order tracker must look up the order before showing status.

Adding a FLOW section to your agent gives it a defined sequence of steps -- each with explicit transitions, data collection, tool calls, and branching logic. The agent itself does not change; the FLOW adds deterministic structure to portions of the conversation that need it.

## Anatomy of a Flow

A flow consists of three parts: a step list, step definitions, and transitions between them.

```abl
FLOW:
  steps:
    - welcome
    - get_destination
    - search_and_show
    - confirm_booking

  welcome:
    REASONING: false
    RESPOND: "Welcome to Hotel Booking! Let's find your perfect hotel."
    THEN: get_destination

  get_destination:
    REASONING: false
    GATHER:
      - destination: required
        prompt: "Where would you like to stay?"
    THEN: search_and_show

  search_and_show:
    REASONING: false
    CALL: search_hotels(destination)
    ON_SUCCESS:
      RESPOND: "Found hotels in {{destination}}!"
      THEN: confirm_booking
    ON_FAIL:
      RESPOND: "No hotels found. Try a different destination."
      THEN: get_destination

  confirm_booking:
    REASONING: false
    RESPOND: "Ready to book? Type 'confirm' or 'change'."
    ON_INPUT:
      - IF: input == "confirm"
        THEN: COMPLETE
      - ELSE:
        THEN: get_destination
```

### Key Elements

- **`steps:`** declares the ordered list of step names. The first step is the default entry point.
- **Each step** has a name (like `welcome`, `get_destination`) and a definition block.
- **`REASONING: false`** makes the step run deterministically without LLM involvement.
- **`THEN:`** specifies the next step to transition to.
- **`THEN: COMPLETE`** ends the session.

## Collecting Data with GATHER

GATHER is the primary mechanism for collecting structured information from users within a flow step. Each field specifies a name, whether it is required, a type for validation, and a prompt to display.

```abl
get_dates:
  REASONING: false
  GATHER:
    - checkin_date: required
      type: date
      prompt: "What is your check-in date?"
    - checkout_date: required
      type: date
      prompt: "What is your check-out date?"
  THEN: get_guests

get_guests:
  REASONING: false
  GATHER:
    - num_guests: required
      type: number
      prompt: "How many guests?"
  THEN: search_and_show
```

When a step has multiple GATHER fields, the Runtime collects them in a natural conversational flow -- asking for each field in sequence. The `type` property enables automatic validation: if a user enters "hello" when the type is `number`, the Runtime re-prompts automatically.

> **Key Concept**: GATHER collects typed data from users with prompts and automatic validation. Supported types include `string`, `number`, `date`, `email`, and more. When a field is marked `required`, the step will not advance until the user provides a valid value. GATHER data is stored in session variables and accessible in subsequent steps via `{{variable_name}}` template interpolation.

### GATHER Field Properties

| Property    | Description                                                   |
| ----------- | ------------------------------------------------------------- |
| `required`  | Field must be collected before proceeding                     |
| `type`      | Data type for validation (string, number, date, email, etc.)  |
| `prompt`    | The question shown to the user                                |
| `sensitive` | Marks the field for PII handling (masking, transient storage) |

## ON_INPUT: Branching on User Input

ON_INPUT provides conditional branching based on what the user enters. This is how you validate input, route conversations, and handle unexpected responses.

```abl
choose_action:
  REASONING: false
  ON_INPUT:
    - IF: input contains "track"
      THEN: tracking_flow
    - IF: input contains "cancel"
      THEN: cancel_flow
    - IF: input contains "return"
      THEN: return_flow
    - ELSE:
      RESPOND: "Please choose: track, cancel, or return."
      THEN: choose_action
```

### How ON_INPUT Works

1. The user sends a message
2. The Runtime evaluates IF conditions **top to bottom**
3. The first matching condition executes its actions (SET, RESPOND, THEN)
4. If no IF condition matches, the ELSE branch executes
5. Each branch can include SET (variable assignment), RESPOND (message), and THEN (transition)

> **Key Concept**: ON_INPUT with IF/ELSE branches validates and routes based on user input. Conditions are evaluated top-to-bottom, and the first match wins. Always include an ELSE branch to handle unexpected input -- without it, unmatched input leaves the user stranded with no response. The ELSE branch typically re-prompts the user and transitions back to the same step.

### Validation Example

```abl
select_hotel:
  REASONING: false
  GATHER:
    - hotel_selection: required
  ON_INPUT:
    - IF: input is_number AND input >= 1 AND input <= hotels.length
      SET: selected_hotel = hotels[input - 1]
      THEN: get_guest_details
    - ELSE:
      RESPOND: "Please enter a valid hotel number."
      THEN: select_hotel
```

This pattern:

1. Collects a hotel selection from the user
2. Validates that it is a number within the valid range
3. Sets a session variable with the selected hotel
4. If invalid, re-prompts and loops back to the same step

### SET: Assigning Variables

Within ON_INPUT branches (and other step constructs), `SET` assigns values to session variables:

```abl
calculate_total:
  REASONING: false
  SET: nights = checkout_date - checkin_date
  SET: total = room_price * nights
  RESPOND: "Your total for {{nights}} nights is ${{total}}."
  THEN: confirm_booking
```

Variables set with SET are available in all subsequent steps via `{{variable_name}}` interpolation.

## THEN: COMPLETE -- Ending the Session

`THEN: COMPLETE` is a special transition that ends the conversation session. When the Runtime reaches this transition, it closes the session and (if configured) sends a closing message.

```abl
confirm_booking:
  REASONING: false
  RESPOND: |
    Booking confirmed!
    Confirmation: {{booking_id}}
    Hotel: {{selected_hotel.name}}
    A confirmation email has been sent to {{guest_email}}.
  THEN: COMPLETE
```

> **Key Concept**: `THEN: COMPLETE` is how you end a flow and close the session. Without it, the conversation would continue indefinitely (or until the session times out). You can also define COMPLETE conditions at the agent level that trigger when specific conditions are met, providing an alternative way to end sessions based on state rather than flow position.

### Agent-Level COMPLETE Conditions

In addition to `THEN: COMPLETE` within flow steps, you can define completion conditions at the agent level:

```abl
COMPLETE:
  - WHEN: booking_confirmed == true
    RESPOND: "Your booking is complete. Thank you!"
  - WHEN: user.says_goodbye == true
    RESPOND: "Thanks for visiting. Goodbye!"
```

These conditions are evaluated on every turn. When one matches, the session ends with the specified response.

## Tool Calls with ON_SUCCESS and ON_FAIL

When a flow step calls a tool, you handle the results with ON_SUCCESS and ON_FAIL branches. This gives you explicit control over what happens when a tool succeeds or fails.

```abl
search_and_show:
  REASONING: false
  CALL: search_hotels(destination, checkin_date, checkout_date, num_guests)
  ON_SUCCESS:
    RESPOND: |
      I found these hotels in {{destination}}:

      {{#each hotels}}
      {{add @index 1}}. {{name}} - ${{price}}/night ({{rating}} stars)
      {{/each}}

      Which hotel would you like to book? Enter the number.
    THEN: select_hotel
  ON_FAIL:
    RESPOND: "No hotels found for your criteria. Let's try different dates."
    THEN: get_dates
```

> **Key Concept**: ON_SUCCESS and ON_FAIL provide explicit branching after a tool call. ON_SUCCESS runs when the tool returns data successfully -- use it to display results and transition forward. ON_FAIL runs when the tool fails or returns no data -- use it to inform the user and redirect to an appropriate recovery step (often going back to collect different input).

### Nested Tool Calls in ON_INPUT

You can nest a CALL inside an ON_INPUT branch, executing the tool only when specific conditions are met:

```abl
confirm_booking:
  REASONING: false
  RESPOND: |
    Please review your booking:
    Hotel: {{selected_hotel.name}}
    Dates: {{checkin_date}} to {{checkout_date}}
    Guest: {{guest_name}} ({{guest_email}})

    Type "confirm" to complete or "change" to start over.
  ON_INPUT:
    - IF: input == "confirm" OR input == "yes"
      CALL: create_booking(selected_hotel.id, guest_name, guest_email, guest_phone)
      ON_SUCCESS:
        RESPOND: |
          Booking confirmed!
          Confirmation: {{booking_id}}
          A confirmation email has been sent to {{guest_email}}.
        THEN: COMPLETE
      ON_FAIL:
        RESPOND: "Booking failed. Please try again."
        THEN: confirm_booking
    - IF: input == "change"
      THEN: get_destination
    - ELSE:
      RESPOND: "Please type 'confirm' or 'change'."
      THEN: confirm_booking
```

This pattern ensures the booking API is only called when the user explicitly confirms.

### ON_SUCCESS with SET

Tool results can be captured into session variables:

```abl
lookup:
  REASONING: false
  CALL: lookup_order(order_id)
  ON_SUCCESS:
    SET: tracking_number = result.tracking_number
    THEN: show_status
  ON_FAIL:
    RESPOND: "I could not find that order. Please check the number."
    THEN: ask_order_id
```

## REASONING: true -- LLM Autonomy Within a Step

The real power of ABL flows is the ability to mix deterministic and LLM-driven steps. Setting `REASONING: true` on a step gives the LLM full autonomy for that step -- it can call tools, ask follow-up questions, and compose responses dynamically.

```abl
FLOW:
  steps:
    - collect_preferences
    - research_options
    - present_plan
    - confirm

  collect_preferences:
    REASONING: false
    GATHER:
      - destination: required
        prompt: "Where would you like to go?"
      - travel_dates: required
        type: date
        prompt: "What are your travel dates?"
      - budget: required
        type: string
        prompt: "What is your budget range?"
    THEN: research_options

  research_options:
    REASONING: true
    GOAL: |
      Research travel options for {{destination}} on {{travel_dates}}
      within a {{budget}} budget. Search flights, hotels, and check weather.
      Compile a recommended itinerary with options at different price points.
    AVAILABLE_TOOLS: [search_flights, search_hotels, get_weather]
    EXIT_WHEN: itinerary_compiled == true
    MAX_TURNS: 8
    THEN: present_plan

  present_plan:
    REASONING: false
    RESPOND: |
      Here is your travel plan for {{destination}}:
      {{compiled_itinerary}}
      Would you like to proceed with booking, or adjust anything?
    ON_INPUT:
      - IF: input contains "book" OR input contains "yes"
        THEN: confirm
      - IF: input contains "change" OR input contains "adjust"
        THEN: collect_preferences
      - ELSE:
        THEN: present_plan

  confirm:
    REASONING: false
    RESPOND: "Booking confirmed. You will receive a confirmation email."
    THEN: COMPLETE
```

> **Key Concept**: Setting `REASONING: true` on a flow step gives the LLM full autonomy within that step. The LLM can call tools, reason about results, ask follow-up questions, and compose responses -- all guided by the step's GOAL and AVAILABLE_TOOLS. Use EXIT_WHEN to define when the reasoning loop ends, and MAX_TURNS to cap iterations and prevent runaway loops.

### Key Properties for Reasoning Steps

| Property           | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `REASONING: true`  | Enables LLM autonomy for this step                    |
| `GOAL`             | Step-specific goal (supplements the agent-level goal) |
| `AVAILABLE_TOOLS`  | Restrict which tools the LLM can use in this step     |
| `EXIT_WHEN`        | Condition that ends the reasoning loop                |
| `MAX_TURNS`        | Maximum reasoning iterations before forced exit       |
| `STEP_CONSTRAINTS` | Additional constraints active only in this step       |

### The Pattern: Deterministic Collection, Intelligent Analysis

The most common pattern combines deterministic data collection with intelligent analysis:

1. **Collect** (REASONING: false): Gather structured data deterministically -- zero LLM cost, predictable
2. **Analyze** (REASONING: true): Let the LLM reason about the data, call tools, and make decisions
3. **Present** (REASONING: false): Show results in a deterministic template -- zero LLM cost, consistent

This pattern gives you the best of both worlds: low cost and high predictability for data collection and presentation, with LLM intelligence focused only where it adds value.

## MAX_ATTEMPTS: Retry Limits for Steps

For steps where the user might need multiple attempts (like identity verification), use MAX_ATTEMPTS to limit retries:

```abl
verify_identity:
  REASONING: false
  MAX_ATTEMPTS: 3
  ON_EXHAUSTED: escalate_to_human
  GATHER:
    - ssn_last_four:
        prompt: "Last 4 digits of your SSN?"
        type: string
        required: true
  CALL: verify_identity(ssn_last_four)
  ON_SUCCESS:
    THEN: authenticated
  ON_FAIL:
    RESPOND: "That did not match. Please try again."
    THEN: verify_identity
```

After 3 failed attempts, the flow transitions to `escalate_to_human` instead of looping forever.

## Building a Complete Flow: Order Tracker

Let us build a complete flow that demonstrates all the concepts covered in this module:

```abl
AGENT: Order_Tracker
GOAL: "Help customers look up and track their orders"

PERSONA: |
  Efficient order specialist. Provides clear status updates.
  Empathetic when orders are delayed.

TOOLS:
  lookup_order(order_id: string) -> {order_id: string, status: string, tracking_number: string, estimated_delivery: string}
    description: "Look up an order by ID"

  get_shipping_details(tracking_number: string) -> {carrier: string, status: string, location: string}
    description: "Get shipping and tracking information"

FLOW:
  steps:
    - ask_order_id
    - lookup
    - show_status
    - shipping_details

  ask_order_id:
    REASONING: false
    GATHER:
      - order_id:
          prompt: "What is your order number? (Format: ORD-XXXXX)"
          type: string
          required: true
    THEN: lookup

  lookup:
    REASONING: false
    CALL: lookup_order(order_id)
    ON_SUCCESS:
      SET: tracking_number = result.tracking_number
      THEN: show_status
    ON_FAIL:
      RESPOND: "I could not find that order. Please check the number and try again."
      THEN: ask_order_id

  show_status:
    REASONING: false
    RESPOND: |
      Order: {{order_id}}
      Status: {{status}}
      Estimated delivery: {{estimated_delivery}}

      Would you like shipping details?
    ON_INPUT:
      - IF: input contains "yes" OR input contains "shipping" OR input contains "track"
        THEN: shipping_details
      - ELSE:
        THEN: COMPLETE

  shipping_details:
    REASONING: false
    CALL: get_shipping_details(tracking_number)
    ON_SUCCESS:
      RESPOND: |
        Carrier: {{carrier}}
        Current location: {{location}}
        Status: {{status}}
      THEN: COMPLETE
    ON_FAIL:
      RESPOND: "Shipping details are unavailable right now."
      THEN: COMPLETE
```

This flow demonstrates:

- GATHER for data collection with type validation
- CALL with ON_SUCCESS/ON_FAIL for tool result handling
- SET for capturing tool results into session variables
- ON_INPUT with IF/ELSE for conditional branching
- THEN: COMPLETE to end the session at multiple exit points

## Key Takeaways

- **ON_INPUT with IF/ELSE** branches validate user input and route the conversation -- always include an ELSE branch to handle unexpected input
- **THEN: COMPLETE** ends the session; without it, the conversation continues until timeout
- **REASONING: true** on a flow step gives the LLM full autonomy within that step, while REASONING: false keeps it deterministic
- **ON_SUCCESS/ON_FAIL** after CALL provide explicit branching based on tool results -- handle both paths for robust flows
- **GATHER** collects typed, validated data from users within flow steps, storing values in session variables for use in subsequent steps

## What's Next

Explore the **Tools and Integrations** module to learn about HTTP tools, MCP bindings, sandbox execution, and advanced tool patterns like CALL WITH and ON_RESULT.
