# Observability in ABL

The important unit of observability in this bundle is not “a model call happened.” It is “a semantic orchestration decision happened.”

## What the trace should make obvious

From the current scenarios, the high-value events are:

- the supervisor handed off to intake
- intake delegated pricing to `Offer_Analyst`
- setup readiness normalized `DEVICE_PORTING`
- a billing credit hit the self-service ceiling
- an auth flow returned to the supervisor
- an SSN was redacted before billing saw it

Those are reviewable because the constructs exist in authored ABL, not just in helper code.

## Example: scenario 7

The auth-return billing scenario should naturally emit a shape like:

- `handoff` to `Authentication_Agent`
- `flow_step_enter` for `collect_last4`
- `tool_call` to `lookup_account`
- `tool_call` to `verify_otp`
- `return_to_parent`
- `handoff` to `Billing_Care_Agent`
- `constraint_check` for the credit ceiling
- `handoff` to `Human_Support_Transfer`

That trace tells an operator not just that “something happened,” but exactly why the session moved from lane to lane.

## What this gives operators

You can answer questions like:

- How often are high-value billing credits routed to a supervisor?
- How often is auth skipped because recent verification still holds?
- Which setup-readiness missing fields block installs most often?
- Which guardrails fire on billing sessions?

The answer is structural because the DSL encoded the structure.

## Why this is different from prompt logs

Prompt logs are useful, but they do not tell you:

- whether a policy failed or the model just chose not to act
- whether ownership changed or a subroutine was invoked
- whether content was blocked by safety policy or by business policy

ABL observability does.
