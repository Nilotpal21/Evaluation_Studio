# Why The Constructs Stay Separate

The common temptation in agent systems is to merge everything into “one flexible orchestration primitive.” This example does the opposite on purpose.

## `GATHER` vs `CONSTRAINTS` vs `GUARDRAILS`

These solve different problems:

- `GATHER` collects the data the agent needs.
- `CONSTRAINTS` evaluate business rules over the gathered and derived state.
- `GUARDRAILS` inspect boundaries like raw input and generated output.

### Worked example: billing credit

In `Billing_Care_Agent`:

- `GATHER` asks whether the customer wants a bill explanation or a credit.
- `GATHER` also collects `credit_amount` and `credit_reason` when needed.
- `CONSTRAINTS` enforce the self-service credit ceiling before `apply_credit` runs.
- `GUARDRAILS` redact SSNs on input and force competitor references back to neutral language on output.

If these were merged, a single rule block would need to answer four different questions at once:

- Is the field present?
- Is the request allowed?
- Is the content safe?
- Should the tool call proceed?

That is exactly the ambiguity ABL avoids.

## `HANDOFF` vs `DELEGATE`

`HANDOFF` changes ownership. `DELEGATE` does not.

This bundle shows both:

- `Supervisor -> Charter_Intake_Agent` is a handoff.
- `Charter_Intake_Agent -> Offer_Analyst` is a delegate call.

If these were merged, the runtime would lose the distinction between:

- “the specialist is now speaking directly”
- “the parent is still speaking but called an internal subroutine”

That hurts UX, traces, and policy review.

## Reasoning vs `FLOW`

Some work should drift a little. Some work should not.

- Reasoning is right for explanation, tradeoff framing, and conversational tone.
- `FLOW` is right for OTP sequencing, setup readiness checkpoints, and callback creation.

Trying to force everything into reasoning creates audit risk. Trying to force everything into rigid flow makes the experience robotic.

## Why observability depends on structure

Because the constructs are separate, the runtime can emit different semantic events:

- `handoff`
- `delegate_start`
- `gather_field_activation`
- `constraint_check`
- `guardrail_check`
- `tool_call`

If all of this were one generalized “step” abstraction, those distinctions would have to be reverse-engineered from logs.
