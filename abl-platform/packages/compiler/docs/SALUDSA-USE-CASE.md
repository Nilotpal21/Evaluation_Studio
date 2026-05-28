# Saludsa Use Case: How the Agent DSL Solves It

## Business Context

**Saludsa** is a health insurance company in Ecuador that needs to automate their customer service across multiple channels (WhatsApp, Web, iOS, Android). Key requirements include:

1. **Identity Verification** - Validate customers before accessing sensitive data
2. **Payment Inquiries** - Check balances, payment history, payment methods
3. **Refund Processing** - Handle reimbursement requests and claim status
4. **Human Escalation** - Smooth handoff to human agents (SAC)
5. **Multi-Channel Support** - Different flows for WhatsApp vs web/mobile
6. **Spanish Localization** - Formal Spanish ("usted" form)
7. **Business Hours Enforcement** - Mon-Fri, 8:00 AM - 6:00 PM Ecuador time

---

## Architecture: Multi-Agent Orchestration (Unified AgentIR)

The DSL implements a **supervisor + specialized agents** pattern. All agents — including the supervisor — compile into the same `AgentIR` type and live in a single unified registry (`CompilationOutput.agents`). The supervisor is identified by `CompilationOutput.entry_agent` and detected at runtime via config presence (`ir.routing?.rules?.length > 0`). This unified design enables hierarchical supervisor composition:

```
                    ┌─────────────────────┐
                    │  Saludsa_Supervisor │
                    │  (Main Orchestrator) │
                    └──────────┬──────────┘
                               │
       ┌───────────────────────┼───────────────────────┐
       │           │           │           │           │
       ▼           ▼           ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  User    │ │ WhatsApp │ │ Pending  │ │ Refund   │ │Transfer  │
│Validator │ │User_Check│ │ Payments │ │ Guidance │ │To_SAC    │
└──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

### Agents Overview

| Agent                 | Purpose                            | Mode      |
| --------------------- | ---------------------------------- | --------- |
| `Saludsa_Supervisor`  | Main orchestrator, intent routing  | reasoning |
| `User_Validator`      | Identity verification (web/mobile) | reasoning |
| `Whatsapp_User_Check` | Identity verification (WhatsApp)   | reasoning |
| `Pending_Payments`    | Payment inquiries, balance checks  | reasoning |
| `Refund_Guidance`     | Refund requests, claim status      | reasoning |
| `Transfer_To_SAC`     | Human agent handoff                | reasoning |
| `Fallback_Handler`    | Unknown intent clarification       | reasoning |
| `Farewell_Agent`      | Graceful conversation closing      | scripted  |

---

## How Each DSL Construct Solves the Problem

### 1. SUPERVISOR with HANDOFF - Intelligent Routing

The supervisor uses conditional routing to direct users to the right specialist:

```dsl
AGENT: Saludsa_Supervisor
MODE: reasoning

HANDOFF:
  # Channel-specific validation
  - TO: User_Validator
    WHEN: user.is_validated == false AND session.channel != "whatsapp"
    PASS: [session_context]

  - TO: Whatsapp_User_Check
    WHEN: user.is_validated == false AND session.channel == "whatsapp"
    PASS: [session_context, inbound_number]

  # Intent-based routing (Spanish + English keywords)
  - TO: Pending_Payments
    WHEN: intent contains "pago" OR intent contains "saldo" OR intent contains "payment"
    PASS: [user_id]

  - TO: Refund_Guidance
    WHEN: intent contains "reembolso" OR intent contains "devolución"
    PASS: [user_id]

  - TO: Transfer_To_SAC
    WHEN: intent contains "agente" OR intent contains "humano"
    PASS: [user_id, transfer_reason]
```

**What this solves:**

- Routes unvalidated WhatsApp users to phone-based verification
- Routes unvalidated web/mobile users to document-based verification
- Routes validated users to specialized agents based on intent
- Supports both Spanish and English keywords

---

### 2. GATHER - Structured Information Collection

The User_Validator uses GATHER to collect consent and documents:

```dsl
AGENT: User_Validator

GATHER:
  consent:
    prompt: "Bienvenido a Saludsa. Para poder ayudarle, necesito verificar su identidad. ¿Acepta nuestra política de tratamiento de datos personales?"
    type: boolean
    required: true

  document_number:
    prompt: "Gracias. Por favor proporcione su número de cédula (10 dígitos) o pasaporte."
    type: string
    required: true
    validation: "^\\d{10}$|^[A-Z]{1,2}\\d{6,9}$"
```

**What this solves:**

- Ensures consent is collected before any data access (GDPR-like compliance)
- Validates document format (Ecuador cedula: 10 digits, or passport format)
- Prompts are in formal Spanish as required by brand guidelines

---

### 3. TOOLS - Backend Integration

Each specialist agent has specific tools for their domain:

```dsl
AGENT: Pending_Payments

TOOLS:
  get_account_balance(user_id: string) -> AccountBalance
  get_payment_history(user_id: string, months: number) -> PaymentHistory
  get_payment_methods() -> PaymentMethods
```

```dsl
AGENT: User_Validator

TOOLS:
  verify_identity(document_type: string, document_number: string) -> VerificationResult
  check_user_exists(document_number: string) -> UserExistsResult
```

**What this solves:**

- Type-safe tool definitions for backend API integration
- Each agent only has access to tools relevant to its function
- Clear input/output contracts for implementation

---

### 4. ESCALATE - Human Handoff Triggers

Each agent defines when to escalate to human support:

```dsl
AGENT: User_Validator

ESCALATE:
  triggers:
    - WHEN: verification_failed == true
      REASON: "User verification failed"
      PRIORITY: medium

    - WHEN: user.requests_human == true
      REASON: "User requested human agent"
      PRIORITY: high

    - WHEN: max_attempts_exceeded == true
      REASON: "Too many failed verification attempts"
      PRIORITY: medium
```

**What this solves:**

- Automatic escalation when verification fails
- Respects user's explicit request for human help (high priority)
- Prevents infinite retry loops with max attempts check
- Priority levels help SAC queue management

---

### 5. LIMITATIONS - Guardrails and Safety

Each agent has clear boundaries:

```dsl
AGENT: Pending_Payments

LIMITATIONS:
  - Cannot process payments directly
  - Cannot modify payment plans
  - Cannot waive fees or make financial promises
```

```dsl
AGENT: Transfer_To_SAC

LIMITATIONS:
  - Cannot guarantee specific wait times
  - Cannot resolve issues that require human agents
  - Cannot transfer outside business hours (Mon-Fri 8:00-18:00)
```

**What this solves:**

- Prevents agents from making promises they can't keep
- Enforces business rules (e.g., no payments through chat)
- Enforces business hours for human handoff
- Provides clear boundaries for LLM behavior

---

### 6. COMPLETE - Graceful Session Endings

Each agent defines successful completion conditions:

```dsl
AGENT: User_Validator

COMPLETE:
  - WHEN: user.is_validated == true
    RESPOND: "Gracias {user_name}. Su identidad ha sido verificada correctamente. ¿En qué puedo ayudarle hoy?"

  - WHEN: consent == false
    RESPOND: "Entendido. Sin su autorización no podemos verificar su identidad. Si cambia de opinión, puede volver a contactarnos."
```

```dsl
AGENT: Transfer_To_SAC

COMPLETE:
  - WHEN: transfer.outside_business_hours == false
    RESPOND: "Lo estoy transfiriendo con uno de nuestros agentes. Por favor permanezca en línea."

  - WHEN: transfer.outside_business_hours == true
    RESPOND: "Nuestros agentes no están disponibles en este momento. Nuestro horario es Lunes a Viernes, 8:00 a 18:00."
```

**What this solves:**

- Different completion messages based on outcome
- Graceful handling of consent refusal
- Business hours awareness for human handoff
- Personalization with variable interpolation (`{user_name}`)

---

### 7. PERSONA - Consistent Brand Voice

All agents share the Saludsa brand voice:

```dsl
PERSONA: |
  Identity Verification Specialist for Saludsa.
  Guides users through verification clearly and patiently.
  Explains why verification is needed when asked.
  Uses formal Spanish (usted).
```

**What this solves:**

- Consistent formal Spanish across all agents
- Patient, helpful tone for customer service
- Clear role identity for each specialist

---

## Complete Flow Examples

### Scenario 1: Web Customer Checks Payment Balance

```
┌─────────────────────────────────────────────────────────────────┐
│ Step │ Actor              │ Action                              │
├─────────────────────────────────────────────────────────────────┤
│  1   │ User (Web)         │ Connects to chat                    │
│  2   │ Supervisor         │ user.is_validated = false           │
│      │                    │ → Routes to User_Validator          │
│  3   │ User_Validator     │ GATHER: "¿Acepta nuestra política?" │
│  4   │ User               │ "Sí, acepto"                        │
│  5   │ User_Validator     │ GATHER: "Su número de cédula"       │
│  6   │ User               │ "1234567890"                        │
│  7   │ User_Validator     │ TOOL: verify_identity() → success   │
│  8   │ User_Validator     │ COMPLETE: "Gracias María. ¿En qué   │
│      │                    │ puedo ayudarle?"                    │
│  9   │ User               │ "Quiero ver mi saldo"               │
│ 10   │ Supervisor         │ Intent: "saldo" → Pending_Payments  │
│ 11   │ Pending_Payments   │ TOOL: get_account_balance()         │
│ 12   │ Pending_Payments   │ "Su saldo pendiente es $150.00"     │
│ 13   │ User               │ "Gracias, eso es todo"              │
│ 14   │ Supervisor         │ Intent: "gracias" → Farewell_Agent  │
│ 15   │ Farewell_Agent     │ "¡Gracias por contactarnos!"        │
└─────────────────────────────────────────────────────────────────┘
```

### Scenario 2: WhatsApp User Outside Business Hours

```
┌─────────────────────────────────────────────────────────────────┐
│ Step │ Actor              │ Action                              │
├─────────────────────────────────────────────────────────────────┤
│  1   │ User (WhatsApp)    │ Connects at 9:00 PM                 │
│  2   │ Supervisor         │ channel = "whatsapp"                │
│      │                    │ → Routes to Whatsapp_User_Check     │
│  3   │ Whatsapp_User_Check│ TOOL: verify_by_phone() → success   │
│  4   │ User               │ "Quiero hablar con alguien"         │
│  5   │ Supervisor         │ Intent: "agente"                    │
│      │                    │ → Routes to Transfer_To_SAC         │
│  6   │ Transfer_To_SAC    │ TOOL: get_queue_status()            │
│      │                    │ outside_business_hours = true       │
│  7   │ Transfer_To_SAC    │ COMPLETE: "Nuestros agentes no      │
│      │                    │ están disponibles. Horario: L-V     │
│      │                    │ 8:00-18:00. ¿Desea dejar mensaje?"  │
│  8   │ User               │ "Sí, por favor"                     │
│  9   │ Transfer_To_SAC    │ GATHER: Collects message            │
│ 10   │ Transfer_To_SAC    │ TOOL: schedule_callback()           │
└─────────────────────────────────────────────────────────────────┘
```

### Scenario 3: Verification Failure → Escalation

```
┌─────────────────────────────────────────────────────────────────┐
│ Step │ Actor              │ Action                              │
├─────────────────────────────────────────────────────────────────┤
│  1   │ User (Web)         │ Connects to chat                    │
│  2   │ User_Validator     │ GATHER: consent + document          │
│  3   │ User               │ Provides invalid document           │
│  4   │ User_Validator     │ TOOL: verify_identity() → failed    │
│  5   │ User_Validator     │ Retry prompt (attempt 2/3)          │
│  6   │ User               │ Provides wrong document again       │
│  7   │ User_Validator     │ TOOL: verify_identity() → failed    │
│  8   │ User_Validator     │ Retry prompt (attempt 3/3)          │
│  9   │ User               │ Provides wrong document again       │
│ 10   │ User_Validator     │ max_attempts_exceeded = true        │
│      │                    │ ESCALATE: priority=medium           │
│ 11   │ Transfer_To_SAC    │ Prepares handoff with context       │
│ 12   │ Human Agent        │ Receives: "3 failed verification    │
│      │                    │ attempts, document: ****7890"       │
└─────────────────────────────────────────────────────────────────┘
```

---

## How the ConstructExecutor Processes This

When the compiled agents run through the ConstructExecutor, here's what happens:

```
┌──────────────────────────────────────────────────────────┐
│                    ExecutionContext                       │
│  sessionId: "whatsapp-123"                               │
│  runtime: "digital"                                       │
│  state.context: { channel: "whatsapp", user_id: null }   │
└──────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│              ConstructExecutor.execute()                  │
│                                                          │
│  Phase 1: memory_recall   → Load persistent user facts   │
│  Phase 2: gather          → Extract phone number         │
│  Phase 3: constraints     → Check guardrails             │
│  Phase 4: delegates       → (none configured)            │
│  Phase 5: escalation      → Check escalation triggers    │
│  Phase 6: handoffs        → Check handoff conditions     │
│  Phase 7: completion      → Check completion conditions  │
│  Phase 8: memory_remember → Store validation result      │
└──────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    ConstructAction                        │
│  { type: "handoff",                                      │
│    target: "Pending_Payments",                           │
│    context: { user_id: "usr_123" },                      │
│    returnExpected: false }                               │
└──────────────────────────────────────────────────────────┘
```

### Execution Pipeline by Construct

| DSL Construct   | Executor           | Runtime Phase                      |
| --------------- | ------------------ | ---------------------------------- |
| GATHER          | GatherExecutor     | `gather`                           |
| MEMORY          | MemoryExecutor     | `memory_recall`, `memory_remember` |
| CONSTRAINTS     | ConstraintExecutor | `constraints`                      |
| ESCALATE        | EscalateExecutor   | `escalation`                       |
| HANDOFF         | HandoffExecutor    | `handoffs`                         |
| COMPLETE        | CompleteExecutor   | `completion`                       |
| DELEGATE        | DelegateExecutor   | `delegates`                        |
| ON_ERROR        | ErrorExecutor      | error handling                     |
| FLOW (scripted) | FlowExecutor       | `flow`                             |

---

## State Management

The supervisor maintains comprehensive state across the conversation:

```dsl
STATE:
  # Session context - set by system
  session.channel              : enum(whatsapp, web, ios, android)
  session.inbound_number       : string
  session.locale               : string = "es-EC"

  # User state - managed by validation agents
  user.is_validated            : boolean = false
  user.user_id                 : string?
  user.role                    : enum(customer, broker, director, unknown)
  user.consent_given           : boolean = false

  # Transfer state
  transfer.handoff_pending     : boolean = false
  transfer.outside_business_hours : boolean
  transfer.reason              : string?

  # Conversation state
  conversation.active_agent    : string?
  conversation.turn_count      : number = 0
```

This state is:

- **Persisted** via FactStore across sessions
- **Shared** between agents during handoffs
- **Type-safe** with defined schemas
- **Auditable** via TraceStore

---

## Summary

The Agent DSL solves the Saludsa use case by providing:

| Requirement           | DSL Solution                          |
| --------------------- | ------------------------------------- |
| Multi-channel support | HANDOFF with channel-based conditions |
| Identity verification | GATHER with validation patterns       |
| Secure data access    | LIMITATIONS + validation requirements |
| Payment inquiries     | Specialized agent with typed TOOLS    |
| Human escalation      | ESCALATE triggers with priorities     |
| Business hours        | COMPLETE conditions + LIMITATIONS     |
| Spanish localization  | PERSONA + RESPOND messages            |
| Graceful endings      | COMPLETE with multiple conditions     |
| State persistence     | MEMORY construct + FactStore          |
| Error handling        | ON_ERROR with retry logic             |
| Audit trail           | TraceStore + AuditStore integration   |

---

## Files Reference

```
examples/saludsa/
├── supervisor.agent.dsl           # Main orchestrator
├── agents/
│   ├── user_validator.agent.dsl   # Web/mobile identity verification
│   ├── whatsapp_user_check.agent.dsl  # WhatsApp identity verification
│   ├── pending_payments.agent.dsl # Payment inquiries
│   ├── refund_guidance.agent.dsl  # Refund requests
│   ├── transfer_to_sac.agent.dsl  # Human handoff
│   ├── fallback_handler.agent.dsl # Unknown intent
│   └── farewell_agent.agent.dsl   # Graceful closing
```

---

## Benefits of DSL Approach

1. **Declarative** - Define _what_ should happen, not _how_
2. **Maintainable** - Business rules are readable by non-developers
3. **Testable** - Each construct can be unit tested independently
4. **Portable** - Same DSL compiles to different runtimes (voice, digital, workflow)
5. **Auditable** - Full trace of decisions and state changes
6. **Safe** - Guardrails prevent unexpected behavior
7. **Scalable** - Add new agents without changing existing ones
