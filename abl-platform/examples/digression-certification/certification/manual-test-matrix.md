# Manual Test Matrix

Use these transcripts in a fresh chat with `Digression_Certification_Agent`.

## Positive Cases

### P1. Global Help Digression Resumes The Current Step

Conversation:

1. User: `guided`
2. User: `help`
3. User: `VPN outage`
4. User: `high`

Pass criteria:

- Turn 2 includes `I can:` and does not cancel the flow.
- Turn 3 is still treated as the issue summary.
- The final review includes `last digression: help_request`.

### P2. Step Digression Explains Priority And Resumes

Conversation:

1. User: `guided`
2. User: `Billing discrepancy`
3. User: `priority bands`
4. User: `medium`

Pass criteria:

- Turn 3 includes the three priority labels.
- The agent stays in the priority step after the explanation.
- The final review includes `last digression: priority_reference`.

### P3. Step Digression Clears Data And Jumps Back

Conversation:

1. User: `guided`
2. User: `VPN outage`
3. User: `change issue`
4. User: `Email outage`
5. User: `high`

Pass criteria:

- Turn 3 responds with `replace the issue summary`.
- The agent returns to issue capture, not review.
- The final review shows `issue: Email outage`, not `VPN outage`.
- The final review includes `last digression: restart_issue`.

### P4. Global Cancel Digression Ends The Workflow

Conversation:

1. User: `guided`
2. User: `VPN outage`
3. User: `cancel`

Pass criteria:

- Turn 3 includes `Cancelling the certification flow now.`
- The flow ends in the `cancelled` step.
- The final response includes `Last digression: cancel_workflow`.

## Negative Cases

### N1. No Lexical Match From `INTENT` Alone

This agent contains a digression with `INTENT: weather_query` and no `KEYWORDS`.

Conversation:

1. User: `guided`
2. User: `weather`

Pass criteria:

- The agent does not respond with `This digression should only run from semantic classification.`
- `weather` is treated like normal issue input and the agent advances to priority capture.

### N2. Step Digression Must Not Fire Outside Its Active Step

Conversation:

1. User: `guided`
2. User: `priority bands`

Pass criteria:

- The agent does not show the priority guide.
- `priority bands` is treated as the issue summary.
- The next prompt asks for priority.

### N3. Global Help Condition Blocks In Handoff-Only Mode

Conversation:

1. User: `handoff only`
2. User: `help`

Pass criteria:

- The agent does not show the help digression text.
- `help` is treated as the issue summary instead.
- The next prompt asks for priority.

### N4. Word-Boundary Matching Prevents `helpful` From Triggering `help`

Conversation:

1. User: `guided`
2. User: `helpful error banner`

Pass criteria:

- The agent does not show the help menu.
- `helpful error banner` is treated as the issue summary.
- The next prompt asks for priority.

### N5. Invalid Priority Input Must Not Complete The Flow

Conversation:

1. User: `guided`
2. User: `VPN outage`
3. User: `i dont know`
4. User: `high`

Pass criteria:

- Turn 3 does not produce the final certification summary.
- The agent stays in the priority step after the invalid value.
- The final review appears only after turn 4 supplies a valid priority.

## Edge Cases

### E1. Mixed Data Plus Digression Keyword Prioritizes The Digression

Conversation:

1. User: `guided`
2. User: `My VPN is down, help`
3. User: `My VPN is down`
4. User: `high`

Pass criteria:

- Turn 2 triggers the global help digression.
- The issue is not captured on turn 2.
- Turn 3 is still required to capture the issue summary.

### E2. Repeating The Same Digression Stays Stable

Conversation:

1. User: `guided`
2. User: `help`
3. User: `help`
4. User: `VPN outage`
5. User: `high`

Pass criteria:

- Both `help` turns return the same help behavior.
- The agent stays in the issue step until turn 4.
- The final review still completes normally.

### E3. Cancel Keywords Should Not Match As Substrings

Conversation:

1. User: `guided`
2. User: `The banner says quitter mode unavailable`
3. User: `medium`

Pass criteria:

- The agent does not cancel on turn 2.
- `quitter` is treated as normal issue text, not as the `quit` keyword.
- The final review shows `issue: The banner says quitter mode unavailable`.
