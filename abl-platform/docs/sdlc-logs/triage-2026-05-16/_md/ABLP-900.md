# ABLP-900 — Root Supervisor Incorrectly Calls **return_to_parent** After Auth Completion In Realtime voice

- Status: To Do
- Assignee: Bhanuraja Kurapati
- Reporter: Upendher Musham
- Priority: None
- Labels: Cigna, go-agentic-priority
- Created: 2026-05-07T18:05:28.108+0530
- Updated: 2026-05-12T14:34:13.798+0530
- Due: 2026-05-15

## Description

In real time voice using the Grok realtime model, the top-level supervisor CignaRouter is incorrectly invoking the _return_to_parent_ tool after authentication is completed by CAIAuth_Specialist.

After the auth flow completes, the trace shows:

“Thread Returned — CAIAuth_Specialist”

At this point, CignaRouter sometimes selects _return_to_parent_ with reasoning such as:

“Authentication successful”

Since CignaRouter is the root/top-level supervisor, it does not have a parent thread. As a result, the tool invocation fails with the following error:

{
"success": false,
"message": "No parent to return to."
}

Expected Behavior

After authentication completes and control returns from CAIAuth_Specialist, CignaRouter should follow:

ON_RETURN: resume_intent

The router should then continue intent-based routing (e.g., order, case, eligibility flows, etc.) instead of attempting a parent return.

Details

    - Model: Grok realtime s2s(grok-2-1212)

    - Project ID: 019dd384-2796-7dd3-8abb-60a40e2143ce

## Comments (2)

### Prasanna Arikala — 2026-05-12T14:06:30.050+0530

Bhanuraja Kurapati Please check this one

### Bhanuraja Kurapati — 2026-05-12T14:34:13.752+0530

okay, will check
