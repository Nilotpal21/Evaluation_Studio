# Scenario 7: Billing Credit With Auth Return

## What this shows

- account-specific billing work can be blocked on authentication without losing the original intent
- `HANDOFF` with `RETURN: true` is different from a terminal transfer
- the auth lane can stay fully deterministic while billing stays hybrid
- the credit ceiling is enforced as runtime policy before `apply_credit` can run

## Deterministic spine

1. The customer asks for a billing credit.
2. The supervisor detects a billing lane but sees no authenticated state.
3. The supervisor hands off to `Authentication_Agent` with `RETURN: true`.
4. Auth runs `collect_last4 -> lookup_candidate -> check_recent -> send_code -> collect_code -> verify_code`.
5. Control returns to the supervisor.
6. The supervisor hands off to `Billing_Care_Agent`.
7. Billing loads the bill and payment history.
8. A credit request above `$50` triggers the credit ceiling and routes to live support.

## Representative transcript

Customer:
My internet was out most of Friday and I want a credit on my bill.

Supervisor:
I can help with that. Because this is account-specific billing work, I need to verify you first and then I’ll bring you right back to billing.

Trace note:
`handoff -> Authentication_Agent (RETURN: true)`

Authentication_Agent:
To verify it’s you, what are the last four digits of the Charter or Spectrum account number?

Customer:
4782

Trace note:
`flow_step collect_last4 -> lookup_candidate`

Trace note:
`tool_call lookup_account`

Authentication_Agent:
I found the account. I’m sending a six-digit code to `***-***-4190`.

Trace note:
`tool_call check_recent_verification`

Trace note:
`tool_call send_otp`

Customer:
384716

Trace note:
`flow_step collect_code -> verify_code`

Trace note:
`tool_call verify_otp`

Authentication_Agent:
Verification is complete. Returning you to the billing specialist.

Trace note:
`return_to_parent`

Supervisor:
You’re verified now. I’m handing this to billing so they can review the credit request with your account context.

Trace note:
`handoff -> Billing_Care_Agent`

Billing_Care_Agent:
I’ve loaded your current bill and recent payment history. Your current total due is `94.99`, and the plan’s approximate daily rate is `3.17`. What credit amount are you requesting for the outage?

Trace note:
`tool_call get_bill`

Trace note:
`tool_call get_payment_history`

Customer:
I want `75`.

Trace note:
`constraint_check credit_amount <= 50 -> failed`

Billing_Care_Agent:
That amount is above the self-service credit ceiling, so I can’t apply it directly here. I’m routing this to live support with your bill total, due date, requested amount, and recent credit context so you don’t need to repeat yourself.

Trace note:
`handoff -> Human_Support_Transfer`

## Fixed tool outputs

### `lookup_account`

```json
{
  "found": true,
  "user_id": "cust_55501",
  "phone_of_record_masked": "***-***-4190"
}
```

### `check_recent_verification`

```json
{
  "verified_recently": false,
  "last_verified_at": "2026-01-10T11:04:00.000Z",
  "days_since": 97
}
```

### `verify_otp`

```json
{
  "valid": true,
  "auth_token": "abl.tkn.cust_55501.verified"
}
```

### `get_bill`

```json
{
  "status": "ok",
  "total_due": 94.99,
  "due_date": "2026-05-02",
  "previous_balance": 0,
  "daily_rate": 3.17
}
```

### `get_payment_history`

```json
{
  "prior_goodwill_credits": 20
}
```

## Why this matters

This is the clearest example in the bundle of deterministic and reasoning orchestration living together:

- auth is scripted because the sequence should not drift
- billing explanation is adaptive because tone and explanation style should stay natural
- the credit ceiling is deterministic because the runtime must enforce the limit before the tool call happens
