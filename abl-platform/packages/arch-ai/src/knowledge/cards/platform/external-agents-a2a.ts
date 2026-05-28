// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: examples/orchestration-and-integration.mdx, api-reference/channels.mdx
// Regenerate: pnpm abl:docs:generate

export const EXTERNAL_AGENTS_A2A_CARD = `## External Agents & A2A — Registration, Protocol, Health

# Orchestration & Integration Examples
- Reusable multi-agent coordination patterns and step-by-step integration recipes for connecting ABL agents to external services.
---
## Orchestration Patterns
- Patterns for multi-agent coordination.
### Pattern 1: Sequential Pipeline (A -> B -> C)
- A chain of agents where each agent completes its work and hands off to the next.
- **When to use:** Multi-stage processing pipelines -- document review, data enrichment, approval chains, or any workflow where each stage depends on the previous stage's output.
\`\`\`mermaid
graph LR
    A[Intake Agent] --> B[Validation Agent]
    B --> C[Processing Agent]
    C --> D[Confirmation Agent]
\`\`\`
#### ABL Implementation
The supervisor manages the pipeline by routing through each stage in sequence:
\`\`\`abl
SUPERVISOR: Document_Pipeline
VERSION: "1.0"
DESCRIPTION: "Sequential document processing pipeline: intake -> validate -> process -> confirm"


GOAL: "Process documents through a sequential pipeline with validation at each stage"

PERSONA: |
  Efficient pipeline coordinator. Moves documents through each stage
  in order, ensuring each step completes before the next begins.

MEMORY:
  session:
    - pipeline_stage
    - document_id
    - validation_result
    - processing_result
    - intake_data

ON_START:
  SET:
    pipeline_stage = "intake"
  RESPOND: "Document processing pipeline ready. Please provide the document to process."

HANDOFF:
  # Stage 1: Intake
  - TO: Intake_Agent
    WHEN: pipeline_stage == "intake"
    CONTEXT:
      pass: [document_id, raw_content]
      summary: "New document for intake processing"
    RETURN: true
    ON_RETURN:
      handler: advance_to_validation
    MAP:
      extracted_data: intake_data
      document_type: document_type

  # Stage 2: Validation
  - TO: Validation_Agent
    WHEN: pipeline_stage == "validation"
    CONTEXT:
      pass: [document_id, intake_data, document_type]
      summary: "Document intake complete -- ready for validation"
    RETURN: true
    ON_RETURN:
      handler: advance_to_processing
    MAP:
      is_valid: validation_result
      errors: validation_errors

  # Stage 3: Processing
  - TO: Processing_Agent
    WHEN: pipeline_stage == "processing" AND validation_result == true
    CONTEXT:
      pass: [document_id, intake_data, document_type]
      summary: "Validation passed -- ready for processing"
    RETURN: true
    ON_RETURN:
      handler: advance_to_confirmation
    MAP:
      result: processing_result
      output_id: output_id

  # Stage 4: Confirmation
  - TO: Confirmation_Agent
    WHEN: pipeline_stage == "confirmation"
    CONTEXT:
      pass: [document_id, processing_result, output_id]
      summary: "Processing complete -- generate confirmation"
    RETURN: true

  # Validation failed -- route to error handler
  - TO: Error_Handler
    WHEN: pipeline_stage == "processing" AND validation_result == false
    CONTEXT:
      pass: [document_id, validation_errors]
      summary: "Validation failed: {{validation_errors}}"
    RETURN: false

COMPLETE:
  - WHEN: pipeline_stage == "complete"
    RESPOND: |
      Document {{document_id}} processed successfully.
      Output ID: {{output_id}}
      All pipeline stages completed.
\`\`\`
**Key pattern characteristics:**
- Each \`HANDOFF\` entry advances the pipeline by one stage.
- \`RETURN: true\` ensures the supervisor regains control after each stage.
- \`MAP\` extracts results from the child agent and stores them in session.
- The supervisor can inspect intermediate results and short-circuit the pipeline (e.g., validation failure).
---
### Pattern 2: Router/Dispatcher
- A supervisor classifies the incoming request and routes it to the appropriate specialist.
- **When to use:** Multi-department customer service, ticket routing, help desk systems, and any application where different request types need different handlers.
\`\`\`mermaid
graph TD
    S[Supervisor] --> |"balance check"| A[Account Agent]
    S --> |"transfer"| B[Transfer Agent]
    S --> |"support"| C[Support Agent]
    S --> |"unclear"| D[Fallback Agent]
    S --> |"frustrated"| E[Human Agent]
\`\`\`
#### ABL Implementation
\`\`\`abl
SUPERVISOR: Service_Router
VERSION: "1.0"
DESCRIPTION: "Routes customer requests to specialist agents based on intent"


GOAL: "Classify the customer's intent and route to the correct specialist"

PERSONA: |
  Efficient service coordinator. Classifies requests accurately
  and routes with full context. Never handles domain logic directly.

MEMORY:
  session:
    - current_intent
    - routing_history
    - handoff_count
  persistent:
    - user.name
    - user.customer_id
  recall:
    - ON: session:start
      ACTION: prompt_llm
      INSTRUCTION: "Check if returning customer"
HANDOFF:
  # Priority 1: Account operations
  - TO: Account_Agent
    WHEN: intent.category == "balance" OR intent.category == "account_details" OR intent.category == "statements"
    CONTEXT:
      pass: [customer_id, session_context]
      summary: "Customer wants account information"
    RETURN: true
    ON_RETURN:
      handler: check_additional_needs
  # Priority 2: Transfers
  - TO: Transfer_Agent
    WHEN: intent.category == "transfer" OR intent.category == "payment"
    CONTEXT:
      pass: [customer_id, session_context]
      summary: "Customer wants to make a transfer or payment"
    RETURN: true
    ON_RETURN:
      handler: check_additional_needs
  # Priority 3: Support
  - TO: Support_Agent
    WHEN: intent.category == "help" OR intent.category == "issue" OR intent.category == "complaint"
    CONTEXT:
      pass: [customer_id, issue_description]
      summary: "Customer needs support"
    RETURN: false

  # Fallback: Unclear intent
  - TO: Fallback_Agent
    WHEN: intent.unclear == true OR intent.confidence < 0.5
    CONTEXT:
      pass: [session_context, last_message]
      summary: "Need clarification on intent"
    RETURN: true
    ON_RETURN:
      handler: reclassify_intent
ESCALATE:
  triggers:
    - WHEN: user.wants_human == true OR user.frustration_detected == true
      REASON: "Customer requested human assistance"
      PRIORITY: high
    - WHEN: handoff_count >= 4
      REASON: "Customer bounced between too many agents"
      PRIORITY: high

ON_ERROR:
  routing_failure:
    RESPOND: "I'm having trouble routing your request. Connecting you with support."
    RETRY: 1
    THEN: ESCALATE with REASON: "Routing failure requires human support"

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Connected you with the right specialist."
\`\`\`
**Key pattern characteristics:**
- Priority ordering ensures urgent cases (escalation) are always handled first.
- \`RETURN: true\` on domain agents allows multi-turn sessions where the customer returns to the router for additional requests.
- \`ESCALATE\` handles human/system escalation without pretending a human queue is a machine agent.
- The fallback agent uses a named \`ON_RETURN\` handler (\`handler: reclassify_intent\`) to re-evaluate the customer's clarified intent.
---
### Pattern 3: Hierarchical Delegation
- A parent agent delegates specific sub-tasks to child agents and uses their results to make decisions.
- **When to use:** Complex decisions that require input from multiple specialists -- risk assessment, compliance checks, pricing calculations, or any workflow where multiple assessments feed into a single decision.
\`\`\`mermaid
graph TD
    P[Wire Transfer Agent] --> |"screen beneficiary"| S[Sanctions Screening]
    P --> |"score risk"| F[Fraud Detection]
    P --> |"calculate fees"| C[Fee Calculator]
    S --> |"result"| P
    F --> |"result"| P
    C --> |"result"| P
    P --> |"all clear"| E[Execute Transfer]
\`\`\`
#### ABL Implementation
\`\`\`abl
AGENT: Wire_Transfer_Agent
VERSION: "1.0"
DESCRIPTION: "Processes wire transfers with delegated compliance checks"


GOAL: "Process wire transfers with sanctions screening, fraud detection, and fee calculation"

PERSONA: |
  Methodical wire transfer specialist. Never executes a wire without
  completing all compliance checks. Transparent about each step.

TOOLS:
  execute_wire(account_id: string, beneficiary_id: string, amount: number, authorization_code: string) -> {confirmation_number: string, status: string}
    description: "Execute the wire transfer after all checks pass"
    type: http
    endpoint: "https://api.bankexample.com/v2/wire/execute"
    method: POST
    auth: bearer
    hints:
      side_effects: true

MEMORY:
  session:
    - sanctions_clear
    - fraud_score
    - dual_auth_required
    - total_fees

# Synchronous sub-agent calls
DELEGATE:
  # Step 1: Sanctions screening
  - AGENT: Sanctions_Screening
    WHEN: beneficiary_name IS SET AND beneficiary_country IS SET
    PURPOSE: "Screen beneficiary against OFAC, EU, and UN sanctions lists"
    INPUT:
      name: beneficiary_name
      country: beneficiary_country
      amount: amount
    RETURNS:
      cleared: sanctions_clear
      match_score: sanctions_match_score
    USE_RESULT: "Block if match_score > 85. Review if 50-85. Proceed if cleared."
    ON_FAILURE: escalate
    FAILURE_MESSAGE: "Sanctions screening unavailable. Cannot proceed -- compliance is mandatory."
    TIMEOUT: "15s"

  # Step 2: Fraud detection
  - AGENT: Fraud_Detection
    WHEN: amount IS SET AND source_account IS SET
    PURPOSE: "Score transaction for fraud risk"
    INPUT:
      account_id: source_account
      amount: amount
      beneficiary_country: beneficiary_country
    RETURNS:
      risk_score: fraud_score
      requires_dual_auth: dual_auth_required
    USE_RESULT: "If score < 40: proceed. If 40-79: require dual auth. If >= 80: block."
    ON_FAILURE: escalate
    TIMEOUT: "10s"

  # Step 3: Fee calculation
  - AGENT: Fee_Calculator
    WHEN: transfer_type IS SET AND amount IS SET
    PURPOSE: "Calculate wire fees and FX conversion"
    INPUT:
      transfer_type: transfer_type
      amount: amount`;
