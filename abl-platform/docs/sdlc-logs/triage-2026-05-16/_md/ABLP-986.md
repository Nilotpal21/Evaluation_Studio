# ABLP-986 — Reasoning step produces empty response when entered via auto-advance from a scripted step

- Status: To Do
- Assignee: Prasanna Arikala
- Reporter: Santhosh Kumar Myadam
- Priority: None
- Labels: (none)
- Created: 2026-05-11T12:43:51.116+0530
- Updated: 2026-05-12T11:31:17.853+0530
- Due: (none)

## Description

Steps:

    - A scripted flow step (e.g., collect_type) matches user input via ON_INPUT and transitions to the next step via THEN

    - The next step (collect_dates) is a REASONING step that relies on an LLM call to generate a prompt

    - Because the user's message was already consumed by the previous step, the reasoning step receives an empty message

    - The reasoning zone does not execute with an empty message — no LLM call is made

    - The step returns an empty response: "The agent returned an empty response"

    - If the user sends the same message again, the reasoning step receives it and works correctly

Expected: reasoning steps entered via auto-advance should still make an LLM call using the GOAL to prompt the user, even without new user input

DSL Definition

AGENT: Leave_Application_Agent
VERSION: "2.0.0"
DESCRIPTION: "Hybrid flow agent that collects leave details from the employee and submits a leave application with reasoning-enabled date parsing and confirmation."

GOAL: |
Guide employees through the leave application process step by step.
Check their balance first, collect leave details, confirm, and submit.
Use reasoning to understand natural language dates and provide intelligent confirmation.

PERSONA: |
You are thorough and helpful. Guide the employee step by step,
confirm before submitting, and explain the approval process.
You understand natural date expressions like "next Monday" or "the week after Thanksgiving."

LIMITATIONS:

- "Cannot approve leave -- only submit requests"
- "Cannot override insufficient balance"
- "Cannot backdate leave more than 7 days"
- "Cannot apply for more days than available balance"

# -----------------------------------------------------------------------------

# TOOLS

# -----------------------------------------------------------------------------

TOOLS:
get_leave_balance(employee_id: string) -> {employee: object, fiscal_year: string, balances: array}
description: "Retrieve the employee's leave balance to check availability before applying."

apply_leave(employee_id: string, leave_type: string, start_date: date, end_date: date, reason?: string) -> {leave_request: object, updated_balance: object}
description: "Submit a leave application. leave_type: annual | sick | personal | parental."
confirm: always

# -----------------------------------------------------------------------------

# MEMORY

# -----------------------------------------------------------------------------

MEMORY:
session: - employee_id - balance_data - leave_type - start_date - end_date - reason

# -----------------------------------------------------------------------------

# FLOW

# -----------------------------------------------------------------------------

FLOW:
entry_point: init
steps: - init - check_balance - collect_type - collect_dates - collect_reason - confirm - submit - show_result

init:
REASONING: true
GOAL: |
Understand the employee's intent to apply for leave.
Use the employee_id from your session context. It is provided by the supervisor.
If the employee already mentioned the leave type or dates, capture what you can.
AVAILABLE_TOOLS: [__set_context__]
EXIT_WHEN: employee_id IS SET
MAX_TURNS: 2
THEN: check_balance

check_balance:
REASONING: false
CALL: get_leave_balance(employee_id)
ON_SUCCESS:
SET: balance_data = get_leave_balance
RESPOND: |
I've retrieved your leave balance. Here's your current availability:

        {{get_leave_balance | json}}


        Let's proceed with your leave request.
      THEN: collect_type
    ON_FAIL:
      RESPOND: "I couldn't retrieve your leave balance. Let me try again."
      RETRY: 1
      THEN: check_balance

collect_type:
REASONING: false
RESPOND: "What type of leave would you like to apply for?"
COLLECT: leave_type
ON_INPUT: - IF: input contains "annual" OR input contains "vacation" OR input contains "pto"
SET: leave_type = "annual"
THEN: collect_dates - IF: input contains "sick" OR input contains "medical" OR input contains "ill"
SET: leave_type = "sick"
THEN: collect_dates - IF: input contains "personal"
SET: leave_type = "personal"
THEN: collect_dates - IF: input contains "parental" OR input contains "maternity" OR input contains "paternity"
SET: leave_type = "parental"
THEN: collect_dates - ELSE:
RESPOND: "Please choose from: annual, sick, personal, or parental leave."
THEN: collect_type

collect_dates:
REASONING: true
GOAL: |
Collect the start date and end date for the leave request.
The employee may use natural language like "next Monday to Friday",
"December 23rd through January 2nd", or "tomorrow for 3 days".
Parse these into YYYY-MM-DD format and set start_date and end_date
using **set_context**.

      Validate that:
      - Start date is not in the past (more than 7 days ago)
      - End date is on or after the start date
      - The number of business days does not exceed available balance for the selected leave type

      Once both dates are confirmed, stop.
    AVAILABLE_TOOLS: [__set_context__]
    EXIT_WHEN: start_date IS SET AND end_date IS SET
    MAX_TURNS: 3

    ON_SUCCESS:
      THEN: collect_reason

collect_reason:
REASONING: false
RESPOND: |
Would you like to add a reason for your leave request?
(Type your reason, or type "skip" to proceed without one.)
COLLECT: reason
ON_INPUT: - IF: input == "skip" OR input == "no" OR input == "none"
SET: reason = ""
THEN: confirm - ELSE:
SET: reason = input
THEN: confirm

confirm:
REASONING: true
GOAL: |
Present a clear summary of the leave application to the employee: - Leave type: {{leave_type}} - Start date: {{start_date}} - End date: {{end_date}} - Reason: {{reason}} (or "None provided") - Estimated business days

      Ask for explicit confirmation before submitting.
      If the employee wants to change something, help them.
      If they confirm, proceed.
    AVAILABLE_TOOLS: [apply_leave, __return_to_parent__]
    EXIT_WHEN: confirmation IS SET
    MAX_TURNS: 3

    ON_SUCCESS:
      THEN: submit

submit:
REASONING: false
CALL: apply_leave(employee_id, leave_type, start_date, end_date, reason)
ON_SUCCESS:
THEN: show_result
ON_FAIL:
RESPOND: |
There was an error submitting your leave request.
Your request has NOT been submitted. Please try again or contact HR at hr@acme.com.
THEN: COMPLETE

show_result:
REASONING: false
RESPOND: |
Your leave request has been submitted successfully!

      Request ID: {{apply_leave.leave_request.id}}
      Status: {{apply_leave.leave_request.status}}
      Leave Type: {{leave_type}}
      Dates: {{start_date}} to {{end_date}}
      Approver: {{apply_leave.leave_request.approver.name}}

      Your manager will be notified and you'll receive an email once it's approved or if further action is needed.
    THEN: COMPLETE

# -----------------------------------------------------------------------------

# ERROR HANDLING

# -----------------------------------------------------------------------------

ON_ERROR:
tool_failure:
RESPOND: "Something went wrong while processing your leave request. Let me try again."
RETRY: 1
THEN: RESPOND "I'm still having trouble. Please try again later or contact HR directly at hr@acme.com."

balance_check_failure:
RESPOND: "I couldn't check your leave balance right now. Let me try once more."
RETRY: 1

# -----------------------------------------------------------------------------

# COMPLETION

# -----------------------------------------------------------------------------

COMPLETE:

- WHEN: show_result IS SET
  RESPOND: "Is there anything else I can help you with?"

## Comments (0)
