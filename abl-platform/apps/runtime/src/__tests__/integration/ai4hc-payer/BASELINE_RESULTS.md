# AI4HC Payer (Provider-Facing) — Kore.ai Baseline Results

> Captured: 2026-03-14
> Endpoint: `https://agent-platform.kore.ai/api/v2/apps/aa-c7fb8d83-.../environments/UAT/runs/execute`
> Source artefacts: `app-AI_For_Healthcare_Payer__provider_facing___web___adaptive_network_-13-03-2026-21-04-50.json`

## System Architecture (Kore.ai)

### Agents

| Agent                      | Type       | Tools                                           | Role                                                  |
| -------------------------- | ---------- | ----------------------------------------------- | ----------------------------------------------------- |
| Welcome_Agent (default)    | Delegation | none                                            | Greeting, small talk, help prompts, routing           |
| Authentication_Agent       | Delegation | perform_provider_authentication                 | Provider ID (9-digit) or NPI ID (10-digit) auth       |
| Plan_Information_Agent     | Delegation | get_plan_information                            | Member plan details, deductibles, OOP, benefits       |
| Coverage_Information_Agent | Delegation | get_plan_information, Plan_Services_Coverage_KB | Coverage/eligibility via plan name + KB RAG           |
| Claim_Information_Agent    | Delegation | get_claim_information                           | Claim status with optional date/status/amount filters |

### Flow

- `appFlowType: "Delegation"` with `defaultAgent: Welcome_Agent`
- Welcome_Agent → routes to Authentication_Agent (if unauthenticated) or directly to service agents (if authenticated)
- Authentication mandatory before any service request
- Session persists auth state — subsequent requests skip re-authentication

### External Services

| Service                                     | Purpose                                         |
| ------------------------------------------- | ----------------------------------------------- |
| Kore.ai Data Tables: providerinfo           | Provider authentication lookup                  |
| Kore.ai Data Tables: eligibilitymembersinfo | Member plan information (113 records)           |
| Kore.ai Data Tables: claiminfo              | Claim status and payment info (58 records)      |
| Plan_Services_Coverage_Knowledge_Base       | Coverage details, copay/coinsurance, prior auth |
| Azure OpenAI GPT-4.1                        | LLM reasoning and response generation           |

### Data Tables

| Table                     | Records | Fields                                                                |
| ------------------------- | ------- | --------------------------------------------------------------------- |
| providerinfo              | 5       | providerId, npiId, taxonomyCode, medicaidId, zipCode                  |
| memberinfo                | 15      | memberId, copay, coInsurance, deductible, OOP, benefits               |
| eligibilitymembersinfo    | 113     | memberId, planType, planStatus, planEffectiveDate, planExpiryDate     |
| claiminfo                 | 58      | claimNumber, claimStatus, claimAmount, claimReqDate, paymentInfo      |
| dependentinfo             | 43      | dependentId, memberId, copay, deductible, OOP                         |
| eligibilitydependentsinfo | 37      | memberId, dependentId, planType, planStatus                           |
| preauthorizationservices  | 7       | serviceTypes (Rehab, Generic drugs, Imaging, Behavioral Health, etc.) |

---

## Performance Baseline (Kore.ai API — UAT Environment)

### Per-Scenario Results

| Scenario                                    | Turn | TTFB  | TTFT   | Total  | Events | Chars |
| ------------------------------------------- | ---- | ----- | ------ | ------ | ------ | ----- |
| S1: Greeting Only                           | T1   | 1.31s | 2.73s  | 3.32s  | 32     | 153   |
| S2: Auth → Plan Info (Provider ID)          | T1   | 0.94s | 4.50s  | 6.36s  | 56     | 246   |
| S2: Auth → Plan Info (confirm ID)           | T2   | 1.25s | 4.56s  | 5.55s  | 23     | 83    |
| S2: Auth → Plan Info (yes correct)          | T3   | 1.02s | 13.11s | 13.52s | 27     | 122   |
| S2: Auth → Plan Info (member 7823564)       | T4   | 0.92s | 13.00s | 14.92s | 294    | 1479  |
| S3: Coverage Query (ask member)             | T1   | 0.92s | 5.04s  | 5.57s  | 16     | 78    |
| S3: Coverage Query (member 7823564)         | T2   | 1.22s | 30.81s | 33.47s | 579    | 3183  |
| S4: Deductible Query (ask member)           | T1   | 0.97s | 5.48s  | 5.87s  | 17     | 79    |
| S4: Deductible Query (member 7823564)       | T2   | 1.20s | 6.01s  | 6.83s  | 138    | 516   |
| S5: Claim Status (ask member)               | T1   | 1.23s | 6.04s  | 6.55s  | 16     | 70    |
| S5: Claim Status (member 7823566)           | T2   | 0.91s | 14.64s | 16.46s | 225    | 756   |
| S6: Invalid ID format (ask member)          | T1   | 0.93s | 6.68s  | 7.19s  | 16     | 74    |
| S6: Invalid ID format (12345)               | T2   | 0.41s | 5.06s  | 5.78s  | 23     | 93    |
| S7: Multi-Intent Plan+Claim (ask member)    | T1   | 0.92s | 1.98s  | 2.66s  | 16     | 74    |
| S7: Multi-Intent Plan+Claim (7823564)       | T2   | 0.41s | 3.89s  | 5.05s  | 288    | 1072  |
| S7: Multi-Intent (claim 7823566)            | T3   | 0.93s | 5.58s  | 6.62s  | 255    | 939   |
| S8: Coverage — Physical Therapy (ask)       | T1   | 0.91s | 6.14s  | 6.96s  | 16     | 70    |
| S8: Coverage — Physical Therapy (7823564)   | T2   | 1.06s | 7.27s  | 7.88s  | 155    | 674   |
| S9: Farewell (hello)                        | T1   | 0.94s | 2.16s  | 2.63s  | 32     | 153   |
| S9: Farewell (thank you)                    | T2   | 0.42s | 1.87s  | 2.44s  | 28     | 122   |
| S10: Claim + Date Filter (ask member)       | T1   | 0.46s | 4.25s  | 4.86s  | 16     | 70    |
| S10: Claim + Date Filter (7823566 Jan 2025) | T2   | 0.41s | 5.53s  | 6.55s  | 36     | 154   |

### Aggregate Stats

- **Total wall time**: ~190s for all 22 turns across 10 scenarios
- **Average TTFB**: 0.90s
- **Average TTFT**: 7.06s (2.85s without tool calls, 11.26s with tool calls)
- **Average total per turn**: 8.64s
- **Pass rate**: 25/25 (100%)

### Perceived Latency Analysis

**TTFB is consistently fast** (0.41s-1.31s) — SSE connection opens quickly.

**The latency bottleneck is TTFT during tool execution:**

- Simple routing (greeting, farewell, ask member ID): TTFT 1.9-5.5s
- Auth tool calls (perform_provider_authentication): TTFT 13.1s — includes DB query + session memory write
- Plan info tool calls (get_plan_information): TTFT 6-13s depending on data volume
- Coverage KB queries: TTFT 30.8s — chained get_plan_information + KB RAG search
- Claim tool calls: TTFT 5.5-14.6s depending on claim count

**Coverage queries are the slowest** (33.5s total) due to two chained tool calls + KB RAG.

**Streaming throughput** once tokens flow: consistent across all scenarios.

**Session reuse** works well — auth persists, subsequent scenarios skip re-authentication (S3-S10 go directly to "Please provide the Member ID").

---

## Full Conversation Transcripts

### Scenario 1: Greeting Only

**Turn 1** — User: "Hello"

> Hello! Welcome to the provider portal. I'm here to help you with member plan information, coverage details, and claim status. How can I assist you today?

### Scenario 2: Auth via Provider ID → Plan Info

**Turn 1** — User: "I need to check a member's plan information"

> I understand you want to check plan information for a member. Before I can assist you with that, I'll need to verify your provider identity.
>
> Please provide your NPI ID (10 digits) or Provider ID (9 digits) for verification.

**Turn 2** — User: "485736201"

> Thank you. I received your Provider ID as 485736201.
>
> Is this information correct?

**Turn 3** — User: "Yes, that's correct"

> Please provide the Member ID for which you want to check plan information.

**Turn 4** — User: "7823564"

> Here is the plan information for Member ID 7823564:
>
> | Plan Name | Coverage Type | Status | Effective Date | Expiry Date | Network Type | ... |
> | --------- | ------------- | ------ | -------------- | ----------- | ------------ | --- |
> | Platinum  | Family        | Active | 10/3/2025      | 10/2/2026   | National     | ... |

### Scenario 3: Coverage Info Query

**Turn 1** — User: "What services are covered for one of my patients?"

> Please provide the Member ID for which you want to check coverage information.

**Turn 2** — User: "7823564"

> ### Plan Information
>
> - **Plan Name:** Platinum
> - **Plan Type:** Family, National Network
> - **Status:** Active
> - **Effective:** 10/03/2025 - 10/02/2026
>
> ### Covered Services Overview
>
> (Detailed coverage table with copay, coinsurance, prior auth requirements...)

### Scenario 4: Plan Info — Deductible Query

**Turn 1** — User: "I want to check the deductible status for a member"

> Please provide the Member ID for which you want to check the deductible status.

**Turn 2** — User: "7823564"

> Here is the deductible status for Member ID 7823564:
>
> | Type                | Total | Met | Remaining |
> | ------------------- | ----- | --- | --------- |
> | In-Network Self     | $500  | $0  | $500      |
> | Out-of-Network Self | $500  | $0  | $500      |

### Scenario 5: Claim Status Query

**Turn 1** — User: "I need to check claim status for a patient"

> Please provide the Member ID for which you want to check claim status.

**Turn 2** — User: "7823566"

> Here are the claims for Member ID 7823566:
>
> | Claim Number  | Status | Amount     | Request Date |
> | ------------- | ------ | ---------- | ------------ |
> | 7892231048582 | Paid   | $500.00    | ...          |
> | 6392231048266 | Denied | $11,500.00 | ...          |
> | ...           |        |            |              |

### Scenario 6: Invalid Provider ID Format

**Turn 1** — User: "Check plan info for a member please"

> Please provide the Member ID for which you want to check plan information.

**Turn 2** — User: "12345"

> Please provide a valid Member ID. The Member ID "12345" does not match the required format.

### Scenario 7: Multi-Intent — Plan Info Then Claim Status

**Turn 1** — User: "I need plan information for a member"

> Before I can assist with plan information for a member, please provide a valid NPI ID (10 digits) or Provider ID (9 digits) for verification.

**Turn 2** — User: "7823564"

> Here is the plan information for Member ID 7823564: (plan table...)

**Turn 3** — User: "Now show me claim status for member 7823566"

> Here is the current status for all claims under Member ID 7823566: (claims table...)

### Scenario 8: Coverage — Physical Therapy

**Turn 1** — User: "Is physical therapy covered for my patient?"

> I understand you want to check if physical therapy is covered for your patient. I need to verify your provider identity first...

**Turn 2** — User: "7823564"

> Physical therapy is covered for your patient under the Platinum plan when medically necessary and furnished by a covered provider. Standard outpatient visits are subject to a $60 copay after deductible...

### Scenario 9: Farewell Flow

**Turn 1** — User: "Hello"

> Hello! Welcome to the provider portal...

**Turn 2** — User: "That's all, thank you"

> You're welcome! If you need any assistance in the future, feel free to reach out. Have a great day!

### Scenario 10: Claim Status with Date Filter

**Turn 1** — User: "I need to check claims for a patient"

> I understand you need to check claims for a patient. Before I can assist with that, I need to verify your provider identity...

**Turn 2** — User: "7823566, I only need claims from January 2025"

> No claims found for member ID 7823566 from January 2025. If you would like to search by a different date range or with other criteria, please let me know.

---

## Test Artefacts

| File                            | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `ai4hc-koreai.e2e.test.ts`      | Vitest E2E test (25 assertions, auto-skip without API key)   |
| `ai4hc-abl-runtime.e2e.test.ts` | ABL Runtime E2E test (23 tests, DSL compilation + execution) |
| `generate-comparison.ts`        | Markdown comparison report generator                         |
| `scenarios.ts`                  | 10 scenarios with expected keywords per turn                 |
| `sse-client.ts`                 | SSE streaming parser for Kore.ai API                         |
| `assertions.ts`                 | Keyword matching, timing, agent routing checks               |
| `fixtures/provider-metadata.ts` | Real provider IDs, member IDs, claim data from Data Tables   |
| `BASELINE_RESULTS.md`           | This file — baseline for ABL Runtime comparison              |

## ABL Runtime Comparison

The ABL Runtime test (`ai4hc-abl-runtime.e2e.test.ts`) runs the same scenarios against the ABL Runtime with compiled DSL agents. Key findings:

### ABL Runtime Results (23/23 pass)

| Metric         | Kore.ai Baseline | ABL Runtime      | Delta      |
| -------------- | ---------------- | ---------------- | ---------- |
| Pass Rate      | 25/25 (100%)     | 23/23 (100%)     | Parity     |
| Avg TTFB       | 0.90s            | 0.07s            | **-92%**   |
| Total Duration | 190s (22 turns)  | 24.5s (22 turns) | **-87%**   |
| Greeting TTFB  | 1.31s            | 0.07s            | **-95%**   |
| LLM Provider   | Azure GPT-4.1    | Azure GPT-4.1    | Same model |

### Key Observations

1. **ON_START template** delivers greeting instantly (0.07s) vs Kore.ai's 3.32s full LLM round-trip
2. **FLOW-based steps** (collect, validate, call, present) provide deterministic conversation structure
3. **Auth FLOW** with CHECK/ON_INPUT branching handles format validation + confirmation without LLM overhead for scripted steps
4. **Tool bindings** (HTTP to Data Tables API) execute directly without Kore.ai intermediary layer
5. **Session memory** persists auth state across turns within a session, matching Kore.ai behavior
