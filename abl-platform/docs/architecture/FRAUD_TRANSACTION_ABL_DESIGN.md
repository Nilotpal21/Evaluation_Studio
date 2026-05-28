# Fraud Transaction Scenario — ABL Design

> **Scenario:** "Show me my last transactions, and connect me to a human agent to discuss a fraudulent transaction."

## Architecture Overview

The scenario needs **3 agents** working together:

```
Customer -> Supervisor -> Transaction_Viewer -> Fraud_Escalation -> Human Agent
```

1. **Supervisor** — Routes intent (view transactions vs. report fraud)
2. **Transaction_Viewer** — Authenticates, fetches & displays transactions, lets user flag a suspicious one
3. **Fraud_Escalation** — Collects fraud details, creates a case, connects to human

---

## 1. Supervisor (`supervisor.agent.abl`)

```abl
AGENT: Supervisor
VERSION: "1.0"
DESCRIPTION: "Routes banking customers to transaction lookup or fraud reporting"

MODE: reasoning

GOAL: "Understand the customer's banking need and connect them with the right specialist"

PERSONA: |
  Friendly and professional banking assistant.
  Quickly identifies whether the customer needs account info, transaction history,
  or fraud assistance — and routes them without unnecessary questions.

LIMITATIONS:
  - Cannot access account data directly — must delegate to specialist agents
  - Cannot process disputes or chargebacks

GATHER:
  intent:
    prompt: "How can I help you today?"
    type: string
    required: true

HANDOFF:
  - TO: Transaction_Viewer
    WHEN: intent contains "transaction" OR intent contains "history" OR intent contains "statement" OR intent contains "last" OR intent contains "recent"
    CONTEXT:
      pass: [intent]
      summary: "Customer wants to view recent transactions"
    RETURN: true

  - TO: Fraud_Escalation
    WHEN: intent contains "fraud" OR intent contains "unauthorized" OR intent contains "dispute" OR intent contains "stolen"
    CONTEXT:
      pass: [intent]
      summary: "Customer reporting potential fraud"
    RETURN: false

COMPLETE:
  - WHEN: handoff.completed == true
    RESPOND: "Is there anything else I can help you with?"
```

### Why this design:

- **`MODE: reasoning`** — The supervisor needs to interpret natural language intent, not follow a rigid script. If a user says "show me my last transactions and I think one is fraud", reasoning mode lets it understand the _primary_ intent (view transactions first) and route accordingly.
- **`RETURN: true` on Transaction_Viewer** — After viewing transactions, control returns to the supervisor so the user can then say "that one looks fraudulent" and get routed to Fraud_Escalation.
- **`RETURN: false` on Fraud_Escalation** — Fraud cases end with a human handoff; there's no reason to return to the supervisor.
- **Separate routing rules** — The user might start with either intent. If they say "show me transactions" first, they get the viewer. If they jump straight to "I have a fraudulent charge", they skip the viewer entirely.

---

## 2. Transaction Viewer (`agents/transaction_viewer.agent.abl`)

```abl
AGENT: Transaction_Viewer
VERSION: "1.0"
DESCRIPTION: "Authenticates customers and displays recent transaction history with fraud flagging"

MODE: scripted

GOAL: "Verify customer identity, show their recent transactions, and allow them to flag any suspicious activity"

PERSONA: |
  Helpful and precise banking assistant.
  Presents transaction data clearly and in a structured format.
  Proactively asks if anything looks unfamiliar after showing transactions.
  Takes fraud concerns seriously and escalates immediately.

LIMITATIONS:
  - "Cannot modify or reverse transactions"
  - "Cannot access transactions without verification"
  - "Cannot process refunds or chargebacks directly"

TOOLS:
  verify_customer(account_number: string, last_four_ssn: string) -> {verified: boolean, customer_id: string, name: string}
    description: "Verify customer identity using account number and last 4 of SSN"

  get_transactions(customer_id: string, limit: number) -> {transactions: array, total_count: number}
    description: "Fetch recent transactions for a verified customer"

  flag_transaction(transaction_id: string, customer_id: string, reason: string) -> {case_id: string, flagged: boolean}
    description: "Flag a specific transaction as suspicious and create an initial case"

MEMORY:
  session:
    - customer_id
    - customer_name
    - transactions
    - flagged_transaction_id
    - case_id

# ─────────────────────────────────────────────────────────────────────────────
# FLOW — verify -> fetch transactions -> review -> flag if needed
# ─────────────────────────────────────────────────────────────────────────────

FLOW:
  entry_point: verify_identity
  steps:
    - verify_identity
    - verify_check
    - fetch_transactions
    - display_transactions
    - check_suspicious
    - flag_suspicious
    - done

  global_digressions:
    - INTENT: "cancel"
      RESPOND: "No problem. You can check your transactions anytime through our app or website."
      GOTO: complete

verify_identity:
  GATHER:
    - account_number: required
      prompt: "Please enter your account number."
      type: string
    - last_four_ssn: required
      prompt: "For verification, what are the last 4 digits of your SSN?"
      type: string
  COMPLETE_WHEN: account_number AND last_four_ssn
  THEN: verify_check

verify_check:
  CALL: verify_customer(account_number, last_four_ssn)
  ON_SUCCESS:
    - IF: verify_customer.verified == true
      SET: customer_id = verify_customer.customer_id
      SET: customer_name = verify_customer.name
      RESPOND: "Welcome, {{customer_name}}. Let me pull up your recent transactions."
      THEN: fetch_transactions
    - ELSE:
      RESPOND: "I couldn't verify your identity. Please check your details and try again."
      THEN: verify_identity
  ON_FAIL:
    RESPOND: "Our verification system is temporarily unavailable. Please try again in a moment."
    THEN: verify_identity

fetch_transactions:
  CALL: get_transactions(customer_id, 10)
  ON_SUCCESS:
    SET: transactions = get_transactions.transactions
    THEN: display_transactions
  ON_FAIL:
    RESPOND: "I'm having trouble retrieving your transactions. Let me try again."
    THEN: fetch_transactions

display_transactions:
  RESPOND: |
    Here are your last {{transactions.length}} transactions, {{customer_name}}:

    {{#each transactions}}
    **{{this.date}}** | {{this.merchant}} | {{this.amount}} | {{this.status}}
    {{/each}}

    Total transactions shown: {{transactions.length}}
  THEN: check_suspicious

check_suspicious:
  COLLECT: suspicious_response
  PROMPT: "Do all of these look familiar? If anything looks suspicious, let me know which transaction and I'll flag it immediately."
  ON_INPUT:
    - IF: input contains "yes" OR input contains "all good" OR input contains "fine" OR input contains "familiar"
      RESPOND: "Great! Your account looks healthy."
      THEN: complete
    - IF: input contains "no" OR input contains "suspicious" OR input contains "fraud" OR input contains "don't recognize" OR input contains "unfamiliar"
      THEN: flag_suspicious
    - ELSE:
      RESPOND: "Do any of these transactions look unfamiliar or suspicious to you?"
      THEN: check_suspicious

flag_suspicious:
  COLLECT: flagged_transaction_id
  PROMPT: "Which transaction looks suspicious? Please provide the date or merchant name so I can identify it."
  THEN: do_flag

do_flag:
  CALL: flag_transaction(flagged_transaction_id, customer_id, "Customer reported as unrecognized")
  ON_SUCCESS:
    SET: case_id = flag_transaction.case_id
    RESPOND: |
      I've flagged that transaction and created case **{{case_id}}**.
      Let me connect you with our fraud specialist team to investigate further.
    THEN: complete
  ON_FAIL:
    RESPOND: "I had trouble flagging that transaction. Let me connect you with our fraud team directly."
    THEN: complete

# ─────────────────────────────────────────────────────────────────────────────
# CONSTRAINTS
# ─────────────────────────────────────────────────────────────────────────────

CONSTRAINTS:
  - REQUIRE customer_id != ""
    ON_FAIL: "Customer must be verified before accessing transactions"

# ─────────────────────────────────────────────────────────────────────────────
# HANDOFF — if fraud detected, escalate
# ─────────────────────────────────────────────────────────────────────────────

HANDOFF:
  - TO: Fraud_Escalation
    WHEN: case_id IS SET
    CONTEXT:
      pass: [customer_id, customer_name, flagged_transaction_id, case_id, transactions]
      summary: "Customer flagged transaction {{flagged_transaction_id}} as suspicious. Case: {{case_id}}"
    RETURN: false

COMPLETE:
  - WHEN: suspicious_response contains "all good"
    RESPOND: "Glad everything looks right. Have a great day, {{customer_name}}!"

  - WHEN: case_id IS SET
    RESPOND: "Connecting you with our fraud team now..."

ON_ERROR:
  tool_timeout:
    RESPOND: "Our banking system is responding slowly. One moment..."
    RETRY: 2
    THEN: CONTINUE

  tool_error:
    RESPOND: "Something went wrong. Let me try a different approach."
    RETRY: 1
    THEN: ESCALATE
```

### Why this design:

- **`MODE: scripted`** — Transaction verification MUST follow a strict sequence: verify identity -> fetch -> display -> review. An LLM in reasoning mode might skip verification or show transactions before confirming identity. Scripted mode enforces this.
- **`GATHER` for identity** — Collects both fields before proceeding. This is a security gate — no transactions without verification.
- **`check_suspicious` step** — Proactively asks "do these look familiar?" after displaying. This is the critical UX bridge between "view transactions" and "report fraud". Without it, the user would have to go back to the supervisor and re-state their intent.
- **`HANDOFF` to Fraud_Escalation with `RETURN: false`** — Once fraud is flagged, the transaction viewer's job is done. The fraud agent takes over permanently.
- **`pass: [customer_id, customer_name, flagged_transaction_id, case_id, transactions]`** — Passes full context so the fraud agent doesn't re-ask for identity or re-fetch transactions. The customer never repeats themselves.
- **`CONSTRAINTS`** — Auto-guarded constraint ensures `customer_id` is verified before any transaction access. The compiler adds `customer_id IS NOT SET OR customer_id != ""`, so the constraint is only enforced once verification has been attempted.

---

## 3. Fraud Escalation (`agents/fraud_escalation.agent.abl`)

```abl
AGENT: Fraud_Escalation
VERSION: "1.0"
DESCRIPTION: "Collects fraud details, secures the account, and connects customer to a human fraud specialist"

MODE: scripted

GOAL: "Gather fraud incident details, take immediate protective action on the account, and ensure seamless handoff to a human fraud investigator with full context"

PERSONA: |
  Calm, reassuring, and security-focused fraud specialist.
  Takes every report seriously. Moves quickly to protect the customer.
  Explains each step clearly so the customer feels in control.
  Never minimizes the customer's concern.

LIMITATIONS:
  - "Cannot reverse or refund transactions — only human investigators can"
  - "Cannot guarantee a specific resolution timeline"
  - "Cannot access the account without a verified customer_id from a prior step"

TOOLS:
  get_transaction_detail(transaction_id: string) -> {merchant: string, amount: number, date: datetime, location: string, card_last_four: string, category: string}
    description: "Get full details of a specific transaction"

  freeze_card(customer_id: string, card_last_four: string) -> {frozen: boolean, temp_card_available: boolean}
    description: "Temporarily freeze the card used in the suspicious transaction"

  create_fraud_case(customer_id: string, transaction_id: string, description: string, severity: string) -> {case_id: string, investigator_assigned: boolean}
    description: "Create a formal fraud investigation case"

  check_fraud_agent_availability(priority: string) -> {available: boolean, estimated_wait: number}
    description: "Check if a human fraud investigator is available"

  transfer_to_human(case_id: string, customer_id: string, context: object) -> {success: boolean, agent_name: string, queue_position: number}
    description: "Transfer to human fraud investigator with full case context"

MEMORY:
  session:
    - transaction_detail
    - fraud_description
    - card_frozen
    - fraud_case_id
    - severity

# ─────────────────────────────────────────────────────────────────────────────
# FLOW — detail -> protect -> case -> human handoff
# ─────────────────────────────────────────────────────────────────────────────

FLOW:
  entry_point: acknowledge
  steps:
    - acknowledge
    - get_detail
    - collect_description
    - assess_severity
    - offer_freeze
    - freeze_card_step
    - create_case
    - check_human
    - do_transfer
    - transfer_success
    - no_human_available

  global_digressions:
    - INTENT: "cancel"
      RESPOND: |
        I understand. Your fraud case {{fraud_case_id}} remains open and will be investigated.
        Call us at 1-800-FRAUD if you change your mind about speaking to an investigator.
      GOTO: complete

acknowledge:
  RESPOND: |
    I take fraud reports very seriously. Let me help you right away.
    I can see the transaction you flagged — let me pull up the full details.
  THEN: get_detail

get_detail:
  CALL: get_transaction_detail(flagged_transaction_id)
  ON_SUCCESS:
    SET: transaction_detail = get_transaction_detail
    RESPOND: |
      Here are the full details of the flagged transaction:

      **Merchant:** {{transaction_detail.merchant}}
      **Amount:** {{transaction_detail.amount}}
      **Date:** {{transaction_detail.date}}
      **Location:** {{transaction_detail.location}}
      **Card ending:** {{transaction_detail.card_last_four}}

      Does this match anything you've done?
    THEN: collect_description
  ON_FAIL:
    RESPOND: "I couldn't pull the details right now, but let's proceed with securing your account."
    THEN: collect_description

collect_description:
  COLLECT: fraud_description
  PROMPT: "Can you briefly describe why this transaction looks fraudulent? (e.g., 'I was not in that city', 'I never shop at that merchant', 'the amount is wrong')"
  THEN: assess_severity

assess_severity:
  CHECK: transaction_detail.amount > 500
    SET: severity = "high"
  CHECK: transaction_detail.amount <= 500
    SET: severity = "medium"
  THEN: offer_freeze

offer_freeze:
  COLLECT: freeze_response
  PROMPT: "For your protection, I recommend temporarily freezing the card ending in {{transaction_detail.card_last_four}}. This prevents further unauthorized charges. Shall I freeze it now?"
  ON_INPUT:
    - IF: input contains "yes" OR input contains "freeze" OR input contains "please"
      THEN: freeze_card_step
    - IF: input contains "no" OR input contains "don't"
      RESPOND: "Understood. You can freeze your card anytime through our app if you change your mind."
      THEN: create_case
    - ELSE:
      RESPOND: "Would you like me to freeze the card? (yes/no)"
      THEN: offer_freeze

freeze_card_step:
  CALL: freeze_card(customer_id, transaction_detail.card_last_four)
  ON_SUCCESS:
    - IF: freeze_card.frozen == true
      SET: card_frozen = true
      RESPOND: |
        Card ending in {{transaction_detail.card_last_four}} is now **frozen**.
        No further charges can go through.
        {{#if freeze_card.temp_card_available}}A temporary virtual card is available in your app for essential purchases.{{/if}}
      THEN: create_case
    - ELSE:
      RESPOND: "I couldn't freeze the card right now. I'll flag this for the investigator as urgent."
      SET: severity = "high"
      THEN: create_case
  ON_FAIL:
    RESPOND: "The card freeze failed. I'm marking this as high priority for the investigator."
    SET: severity = "high"
    THEN: create_case

create_case:
  CALL: create_fraud_case(customer_id, flagged_transaction_id, fraud_description, severity)
  ON_SUCCESS:
    SET: fraud_case_id = create_fraud_case.case_id
    RESPOND: |
      Fraud case **{{fraud_case_id}}** has been created with **{{severity}}** priority.
      {{#if create_fraud_case.investigator_assigned}}An investigator has already been assigned.{{/if}}
      Now let me connect you with a fraud specialist.
    THEN: check_human
  ON_FAIL:
    RESPOND: "I had trouble creating the case, but let me connect you with a specialist who can help."
    THEN: check_human

check_human:
  CALL: check_fraud_agent_availability(severity)
  ON_SUCCESS:
    - IF: check_fraud_agent_availability.available == true
      RESPOND: "A fraud investigator is available. Estimated wait: ~{{check_fraud_agent_availability.estimated_wait}} minutes."
      THEN: do_transfer
    - ELSE:
      THEN: no_human_available
  ON_FAIL:
    THEN: do_transfer

do_transfer:
  CALL: transfer_to_human(fraud_case_id, customer_id, {transaction: transaction_detail, description: fraud_description, card_frozen: card_frozen, severity: severity, conversation_history: conversation_history})
  ON_SUCCESS:
    - IF: transfer_to_human.success == true
      THEN: transfer_success
    - ELSE:
      THEN: no_human_available
  ON_FAIL:
    THEN: no_human_available

transfer_success:
  RESPOND: |
    You're being connected to **{{transfer_to_human.agent_name}}** now.

    They already have:
    - Your flagged transaction details
    - Your fraud description
    - Card freeze status
    - Full conversation history

    **You won't need to repeat anything.**
    Case reference: **{{fraud_case_id}}**

    Thank you for reporting this, {{customer_name}}. We take this very seriously.
  THEN: complete

no_human_available:
  RESPOND: |
    No fraud investigators are available right now, but your case **{{fraud_case_id}}** is logged
    with **{{severity}}** priority and will be reviewed promptly.

    What you can do:
    - Your card is {{#if card_frozen}}frozen — no further charges can go through{{else}}still active — consider freezing it in the app{{/if}}
    - An investigator will call you within 24 hours
    - For urgent concerns, call our fraud hotline: **1-800-FRAUD**

    Reference your case ID: **{{fraud_case_id}}**
  THEN: complete

# ─────────────────────────────────────────────────────────────────────────────
# CONSTRAINTS
# ─────────────────────────────────────────────────────────────────────────────

CONSTRAINTS:
  - REQUIRE customer_id != ""
    ON_FAIL: "A verified customer is required for fraud reporting"

# ─────────────────────────────────────────────────────────────────────────────
# ESCALATION — human connection is the primary exit
# ─────────────────────────────────────────────────────────────────────────────

ESCALATE:
  triggers:
    - WHEN: severity == "high"
      REASON: "High-value suspicious transaction flagged by customer"
      PRIORITY: critical
      TAGS: [fraud, high_value]

    - WHEN: card_frozen == false AND severity == "high"
      REASON: "High-severity fraud with card NOT frozen — immediate risk"
      PRIORITY: critical
      TAGS: [fraud, card_active, urgent]

    - WHEN: transfer_to_human.success == false
      REASON: "Failed to connect customer to human fraud investigator"
      PRIORITY: high
      TAGS: [fraud, transfer_failed]

  context_for_human:
    - customer_id
    - customer_name
    - flagged_transaction_id
    - transaction_detail
    - fraud_description
    - card_frozen
    - severity
    - fraud_case_id
    - conversation_history

COMPLETE:
  - WHEN: transfer_to_human.success == true
    RESPOND: "You're now connected with our fraud team. Stay safe!"

  - WHEN: fraud_case_id IS SET AND transfer_to_human.success != true
    RESPOND: "Your case {{fraud_case_id}} is open. An investigator will contact you within 24 hours."

ON_ERROR:
  tool_timeout:
    RESPOND: "Our systems are responding slowly. Your security is our priority — one moment..."
    RETRY: 2
    THEN: CONTINUE

  tool_error:
    RESPOND: "Something went wrong, but your report is safe. Let me try another way."
    RETRY: 1
    THEN: ESCALATE
```

---

## Design Rationale

### 1. Three agents, not one

A single monolithic agent would be tempting, but it violates **separation of concerns**:

- **Transaction_Viewer** is reusable for non-fraud scenarios (checking balances, export, etc.)
- **Fraud_Escalation** can be reached from _multiple_ entry points (supervisor direct, transaction viewer, or even other agents)
- Each agent has a clear **security boundary** — the viewer can't freeze cards, the escalator can't show arbitrary transactions

### 2. `MODE: scripted` for both child agents

Both Transaction_Viewer and Fraud_Escalation use scripted mode because:

- **Compliance** — Banking flows must follow exact steps. An LLM in reasoning mode might skip verification or forget to offer a card freeze.
- **Auditability** — Every step is deterministic and traceable. Regulators can review the exact flow path.
- **Security** — The `CONSTRAINTS` block ensures no transaction access without verification. Scripted mode respects this gate absolutely.

### 3. `MODE: reasoning` for the Supervisor only

The supervisor needs flexibility to interpret ambiguous input like _"show me recent charges and one looks weird"_ — which is both a transaction request AND a fraud hint. Reasoning mode lets it pick the right starting point (Transaction_Viewer first, since the user needs to see the data before flagging).

### 4. Context passing eliminates repetition

The `PASS` chain ensures data flows downstream:

```
Supervisor passes [intent] -> Transaction_Viewer
Transaction_Viewer passes [customer_id, flagged_transaction_id, case_id, transactions] -> Fraud_Escalation
Fraud_Escalation passes [everything] -> Human Agent
```

The customer authenticates **once** and never repeats themselves. The human agent receives the full picture.

### 5. Proactive protection before human handoff

The Fraud_Escalation agent doesn't just connect to a human — it **acts first**:

1. Shows full transaction details (so the customer confirms)
2. Offers to freeze the card (immediate protection)
3. Creates a formal case (so nothing is lost if transfer fails)
4. _Then_ connects to human

This means even if the human transfer fails, the customer is already protected (card frozen, case open).

### 6. Graceful degradation throughout

Every tool call has `ON_FAIL` handlers that never dead-end:

- Verification fails -> retry
- Transaction fetch fails -> retry
- Card freeze fails -> escalate severity and continue
- Human unavailable -> provide case reference + hotline number

The customer always has a path forward.

### 7. The `check_suspicious` bridge

This step in Transaction*Viewer is the key UX insight. Instead of making the customer navigate back to the supervisor and say "now I want to report fraud", the agent proactively asks *"does anything look unfamiliar?"\_ right after showing transactions. This matches the natural conversation flow of the scenario: "show me my last transactions" followed by "that one looks fraudulent".

---

## Conversation Flow Example

```
Customer: "Show me my last transactions"
  -> Supervisor routes to Transaction_Viewer

Transaction_Viewer: "Please enter your account number."
Customer: "AC12345678"

Transaction_Viewer: "For verification, what are the last 4 digits of your SSN?"
Customer: "9876"

Transaction_Viewer: "Welcome, John! Here are your last 10 transactions:
  2024-01-15 | Amazon    | $45.99  | completed
  2024-01-14 | Uber      | $23.50  | completed
  2024-01-13 | UNKNOWN_MERCHANT_XYZ | $892.00 | completed
  ...
  Do all of these look familiar?"

Customer: "I don't recognize that $892 charge"

Transaction_Viewer: "Which transaction? Please provide the date or merchant."
Customer: "The UNKNOWN_MERCHANT_XYZ one on Jan 13"

Transaction_Viewer: "I've flagged that transaction and created case FC-2024-0891.
  Let me connect you with our fraud specialist team."
  -> HANDOFF to Fraud_Escalation with full context

Fraud_Escalation: "I take fraud reports very seriously. Here are the full details:
  Merchant: UNKNOWN_MERCHANT_XYZ
  Amount: $892.00
  Location: Lagos, Nigeria
  Card ending: 4521
  Does this match anything you've done?"

Customer: "No, I've never been to Nigeria"

Fraud_Escalation: "I recommend freezing card ending 4521. Shall I?"
Customer: "Yes please"

Fraud_Escalation: "Card frozen. No further charges can go through.
  Fraud case FC-2024-0891 created with HIGH priority.
  Connecting you with investigator Sarah M. now...
  They have your full history. You won't repeat anything."
  -> Human takes over
```
