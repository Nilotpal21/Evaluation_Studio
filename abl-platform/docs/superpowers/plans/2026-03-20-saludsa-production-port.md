# Saludsa Production Port — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Saludsa "Samy" virtual health insurance assistant (16 agents + supervisor) from Kore.ai to ABL Platform with full behavioral parity and real MCP tool bindings.

**Architecture:** 1:1 agent port into `examples/saludsa-production/`. 17 ABL agent files, 12 tool registry files (8 MCP + 4 code), config files, Spanish locale files, and an unimplemented gaps document. All tools bind to the real Saludsa MCP backend — no mocks.

**Tech Stack:** ABL DSL (.agent.abl, .tools.abl), JSON config, Ecuadorian Spanish localization

**Spec:** `docs/superpowers/specs/2026-03-20-saludsa-production-port-design.md`
**Source Analysis:** `/Users/Thiru/researchWS/Saludsa/saludsa-to-abl-porting-analysis.md`
**Kore.ai Export:** `/Users/Thiru/researchWS/Saludsa/app-saludsa_app_temp-09-03-2026-18-07-43.json`

**CRITICAL INSTRUCTIONS FOR AGENTS:**

- Run `npx prettier --write <files>` on ALL changed files before finishing your task
- BEFORE using any existing ABL component/function/type, READ its source file to verify the actual signature
- Reference existing ABL examples at `examples/travel/` and `examples/telco/` for DSL syntax patterns
- All user-facing text MUST be in Ecuadorian Spanish (formal "usted" register)
- DO NOT create mock tool responses — all tools bind to real endpoints
- Every `.agent.abl` file MUST follow the standard template in Spec Section 8.0
- **CRITICAL ABL PARSER RULE:** Agent `.agent.abl` files CANNOT use `FROM "./tools/..." USE:` syntax — this triggers E720 error. Instead, declare tools as **signature-only** in the agent's TOOLS section (just name + params + return type + description). The actual HTTP/sandbox bindings live in the `.tools.abl` files registered in `project.json`. The runtime resolves tool names automatically by matching the agent's signature-only declaration to the tool file's full definition.
- Sandbox tool JavaScript code accesses parameters via `$paramName` syntax (e.g., `const id = $idCardOrPassport;`)

---

## Chunk 1: Project Infrastructure

### Task 1: Create directory structure and config files

**Files:**

- Create: `examples/saludsa-production/project.json`
- Create: `examples/saludsa-production/config/project-settings.json`
- Create: `examples/saludsa-production/environment/env-vars.json`
- Create: `examples/saludsa-production/README.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p examples/saludsa-production/{agents,tools,locales/es,config,environment,docs}
```

- [ ] **Step 2: Create project.json**

Create `examples/saludsa-production/project.json`:

```json
{
  "format_version": "2.0",
  "name": "saludsa-production",
  "description": "Saludsa Samy — Production health insurance virtual assistant ported from Kore.ai",
  "entry_agent": "Samy_Supervisor",
  "dsl_format": "legacy",
  "abl_version": "1.0",
  "language": "es-EC",
  "agents": {
    "Samy_Supervisor": { "file": "agents/samy_supervisor.agent.abl", "type": "supervisor" },
    "Client_Entry_Gateway": { "file": "agents/client_entry_gateway.agent.abl", "type": "agent" },
    "Broker_Entry_Gateway": { "file": "agents/broker_entry_gateway.agent.abl", "type": "agent" },
    "Transfer_Services": { "file": "agents/transfer_services.agent.abl", "type": "agent" },
    "Contract_Data_Assistant": {
      "file": "agents/contract_data_assistant.agent.abl",
      "type": "agent"
    },
    "Contract_Sending": { "file": "agents/contract_sending.agent.abl", "type": "agent" },
    "Pending_Payments": { "file": "agents/pending_payments.agent.abl", "type": "agent" },
    "Password_Reset": { "file": "agents/password_reset.agent.abl", "type": "agent" },
    "Refund_Guidance": { "file": "agents/refund_guidance.agent.abl", "type": "agent" },
    "Refund_Status": { "file": "agents/refund_status.agent.abl", "type": "agent" },
    "Coverage_Certificates": { "file": "agents/coverage_certificates.agent.abl", "type": "agent" },
    "Other_Services": { "file": "agents/other_services.agent.abl", "type": "agent" },
    "Transfer_To_Vitality": { "file": "agents/transfer_to_vitality.agent.abl", "type": "agent" },
    "Transfer_To_SAC": { "file": "agents/transfer_to_sac.agent.abl", "type": "agent" },
    "PCA_XPR_Transfer": { "file": "agents/pca_xpr_transfer.agent.abl", "type": "agent" },
    "Fallback_Handler": { "file": "agents/fallback_handler.agent.abl", "type": "agent" },
    "Farewell_Handler": { "file": "agents/farewell_handler.agent.abl", "type": "agent" }
  },
  "tools": {
    "saludsa-identity": { "file": "tools/saludsa-identity.tools.abl" },
    "saludsa-otp": { "file": "tools/saludsa-otp.tools.abl" },
    "saludsa-services": { "file": "tools/saludsa-services.tools.abl" },
    "saludsa-coverage": { "file": "tools/saludsa-coverage.tools.abl" },
    "saludsa-transfer": { "file": "tools/saludsa-transfer.tools.abl" },
    "saludsa-zendesk": { "file": "tools/saludsa-zendesk.tools.abl" },
    "saludsa-refund": { "file": "tools/saludsa-refund.tools.abl" },
    "saludsa-misc": { "file": "tools/saludsa-misc.tools.abl" },
    "code-identity": { "file": "tools/code-identity.tools.abl" },
    "code-otp": { "file": "tools/code-otp.tools.abl" },
    "code-transfer": { "file": "tools/code-transfer.tools.abl" },
    "code-misc": { "file": "tools/code-misc.tools.abl" }
  },
  "metadata": {
    "source": "Kore.ai Agent Platform (saludsa_app_temp)",
    "exported": "2026-03-09",
    "ported": "2026-03-20",
    "port_type": "1:1 production"
  }
}
```

- [ ] **Step 3: Create config/project-settings.json**

Create `examples/saludsa-production/config/project-settings.json`:

```json
{
  "execution": {
    "default_model": "gpt-4.1",
    "fallback_model": "gpt-4o-mini",
    "default_temperature": 0.1,
    "default_top_p": 0.7,
    "default_max_tokens": 9999,
    "timeout": 120,
    "pipeline": {
      "enabled": true,
      "mode": "sequential",
      "model": "qwen35-a3b-35b",
      "shortCircuit": {
        "enabled": true,
        "confidenceThreshold": 0.85
      }
    }
  },
  "business_hours": {
    "timezone": "America/Guayaquil",
    "schedule": {
      "monday": { "start": "08:30", "end": "17:30" },
      "tuesday": { "start": "08:30", "end": "17:30" },
      "wednesday": { "start": "08:30", "end": "17:30" },
      "thursday": { "start": "08:30", "end": "17:30" },
      "friday": { "start": "08:30", "end": "17:30" }
    }
  },
  "language": "es-EC",
  "formal_register": true
}
```

- [ ] **Step 4: Create environment/env-vars.json**

Create `examples/saludsa-production/environment/env-vars.json`:

```json
{
  "variables": [
    {
      "name": "SALUDSA_MCP_ENDPOINT",
      "description": "Saludsa MCP server base URL",
      "required": true,
      "example": "https://pruebassac.saludsa.com.ec/servicioalcliente/mcpintegracionivr"
    },
    {
      "name": "SALUDSA_MCP_AUTH",
      "description": "Basic auth credentials for MCP server (base64 encoded)",
      "required": true,
      "sensitive": true
    },
    {
      "name": "CC_STREAM_ID",
      "description": "Kore.ai Contact Center stream ID for agent handoff",
      "required": true
    },
    {
      "name": "CC_ACCOUNT_ID",
      "description": "Kore.ai Contact Center account ID",
      "required": true
    },
    {
      "name": "CC_OPERATIONS_HOURS_URL",
      "description": "Contact Center operations hours API base URL (legacy — prefer validateoutofhours MCP tool)",
      "required": false
    },
    {
      "name": "CC_OPERATIONS_HOURS_TOKEN",
      "description": "Auth token for CC operations hours API (legacy)",
      "required": false,
      "sensitive": true
    }
  ]
}
```

- [ ] **Step 5: Create README.md**

Create `examples/saludsa-production/README.md`:

```markdown
# Saludsa Production — Samy Virtual Assistant

Production port of Saludsa's "Samy" health insurance virtual assistant from Kore.ai Agent Platform to ABL Platform.

## Architecture

- **Supervisor:** Samy_Supervisor — 4-level priority routing cascade
- **16 specialist agents** — 1:1 mapping with Kore.ai source
- **30 MCP tools** — Real Saludsa backend (no mocks)
- **15 code tools** — Ported as sandbox tools or FLOW logic

## Agents

| Agent                   | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| Client_Entry_Gateway    | Identity validation (cédula/passport) for WhatsApp/Voice |
| Broker_Entry_Gateway    | 3-step broker validation (ID → OTP → Client ID)          |
| Transfer_Services       | Dr. Salud medical services (5 sub-flows)                 |
| Contract_Data_Assistant | Contract status lookup with security question auth       |
| Contract_Sending        | Contract document delivery                               |
| Pending_Payments        | Payment inquiries with OTP auth                          |
| Password_Reset          | Password reset with role eligibility                     |
| Refund_Guidance         | Reimbursement step-by-step guidance                      |
| Refund_Status           | Immediate SAC transfer for refund status                 |
| Coverage_Certificates   | Coverage/travel certificate generation                   |
| Other_Services          | Dental, funeral, travel partner routing                  |
| Transfer_To_Vitality    | Vitality wellness program transfer                       |
| Transfer_To_SAC         | Customer service escalation with menu                    |
| PCA_XPR_Transfer        | Priority product routing                                 |
| Fallback_Handler        | Unrecognized input with 4-option menu                    |
| Farewell_Handler        | Graceful conversation closure                            |

## Configuration

Set environment variables before running:

- `SALUDSA_MCP_ENDPOINT` — MCP server base URL
- `SALUDSA_MCP_AUTH` — Basic auth credentials (base64)
- `CC_STREAM_ID` — Contact Center stream ID
- `CC_ACCOUNT_ID` — Contact Center account ID

## Language

All communication is in Ecuadorian Spanish (formal "usted" register).
Business hours: Mon–Fri 8:30am–5:30pm America/Guayaquil.
```

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write examples/saludsa-production/project.json examples/saludsa-production/config/project-settings.json examples/saludsa-production/environment/env-vars.json examples/saludsa-production/README.md
```

---

## Chunk 2: MCP Tool Registries

All 30 MCP tools organized into 8 registry files. Each tool connects to the Saludsa backend via HTTP with Basic auth. The `sessionId` parameter is required on every tool and must be passed verbatim from the ABL session context.

**Common tool registry header for all MCP files:**

```
base_url: "${SALUDSA_MCP_ENDPOINT}"
auth: basic
timeout: 45000
auth_config:
  header_name: "Authorization"
  provider: "${SALUDSA_MCP_AUTH}"
```

**IMPORTANT — ABL parser facts (verified against `packages/core/src/parser/tool-file-parser.ts`):**

- The `TOOLS:` block with shared `base_url`, `auth`, `timeout`, `auth_config` headers IS supported
- `base_url` is prepended to relative `endpoint:` paths on HTTP tools
- `credentials:` is NOT a valid parser keyword — use `auth_config:` instead
- Agent `.agent.abl` files CANNOT use `FROM "./tools/..." USE:` syntax (E720 error) — tools in agent files must be **signature-only** declarations; implementation bindings live in `.tools.abl` files registered via `project.json`
- Sandbox tool parameters are accessed via `$paramName` in JavaScript code

### Task 2: Create identity and OTP tool registries

**Files:**

- Create: `examples/saludsa-production/tools/saludsa-identity.tools.abl`
- Create: `examples/saludsa-production/tools/saludsa-otp.tools.abl`

- [ ] **Step 1: Create saludsa-identity.tools.abl**

Create `examples/saludsa-production/tools/saludsa-identity.tools.abl` with these 7 tools:

```
/**
 * Saludsa Identity Verification Tools
 * MCP tools for user validation, broker validation, and security questions.
 * All tools connect to the Saludsa MCP backend.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  userValidation(telePhoneNum: string, inboundNumber: string, channel: string = "voice", botUserId: string = "", botSessionId: string = "", sessionId: string) -> {userType: string, timeSlot: string, title: string, surName: string, apiIdCard: string, ticketId: string}
    type: http
    endpoint: "/userValidation"
    method: POST
    description: "Validate user type by phone number. Returns userType (Cliente, Broker, Director, Business Representative, non client), timeSlot, title, surName."

  validate_user(idCard: string, channel: string = "web", botUserId: string = "", botSessionId: string = "", sessionId: string) -> {success: boolean, role: string, contractId: string, ticketId: string, customerName: string, needs_consent: boolean, apiError: boolean, priorityTransfer: string, isXPRExist: boolean, isPCAExist: boolean, isDRSExist: boolean, isTRKExist: boolean, customerDetails: object}
    type: http
    endpoint: "/validateUser"
    method: POST
    description: "Validate user by cédula/ID card number. Primary identity validation for clients."

  validate_broker(idCard: string, channelType: string, sessionId: string) -> {success: boolean, apiError: boolean, message: string}
    type: http
    endpoint: "/validate-broker"
    method: POST
    description: "Validate broker by ID card."

  validarAgenteVenta(brokerCode: number, sessionId: string) -> {success: boolean, apiError: boolean, message: string}
    type: http
    endpoint: "/validarAgenteVenta"
    method: POST
    description: "Validate sales agent by director code or broker code."

  consultarAgenteVenta(idCardOrPassport: string, userRole: string, userPhoneNumber: string, fromUserValidation: string = "", sessionId: string) -> {success: boolean, apiError: boolean, message: string, brokerDetails: object}
    type: http
    endpoint: "/consultarAgenteVenta"
    method: POST
    description: "Validate sales agent by national ID card of Broker/Director."

  checkPriorityTransfer(idCard: string, channel: string = "web", sessionId: string) -> {hasPriority: boolean, transferType: string}
    type: http
    endpoint: "/checkPriorityTransfer"
    method: POST
    description: "Check XPR/PCA/SAC priority transfer eligibility."

  getSecurityQuestions(sessionId: string) -> {question: string, isOtpVerified: boolean, isAuthQVerified: boolean}
    type: http
    endpoint: "/getSecurityQuestions"
    method: POST
    description: "Return one random security question by user role (Holder, Beneficiary, Payer). Returns isOtpVerified/isAuthQVerified flags if already authenticated."
```

- [ ] **Step 2: Create saludsa-otp.tools.abl**

Create `examples/saludsa-production/tools/saludsa-otp.tools.abl` with these 4 tools:

```
/**
 * Saludsa OTP Tools
 * MCP tools for OTP generation and validation.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  generate_otp(sessionId: string) -> {success: boolean, message: string}
    type: http
    endpoint: "/otpGenerator"
    method: POST
    description: "Generate OTP for phone verification. Backend fetches phone from Redis session and sends OTP to registered number."

  validate_otp(userProvidedCodigoOtp: string, sessionId: string) -> {success: boolean, otpValidated: boolean, message: string}
    type: http
    endpoint: "/otpValidator"
    method: POST
    description: "Validate OTP (broker flow). Used during Broker_Entry_Gateway validation."

  validate_otp_client(codigoOtpGenerado: string, sessionId: string) -> {success: boolean, otpValidated: boolean, message: string}
    type: http
    endpoint: "/validate-otp-client"
    method: POST
    description: "Validate OTP (client flow). Used for payments and password reset."

  pendingPaymentOtp(sessionId: string, userId: string = "") -> {success: boolean, message: string}
    type: http
    endpoint: "/pendingPaymentOtp"
    method: POST
    description: "Validate phone number for OTP in payment flow."
```

- [ ] **Step 3: Format files**

```bash
npx prettier --write examples/saludsa-production/tools/saludsa-identity.tools.abl examples/saludsa-production/tools/saludsa-otp.tools.abl
```

### Task 3: Create service and coverage tool registries

**Files:**

- Create: `examples/saludsa-production/tools/saludsa-services.tools.abl`
- Create: `examples/saludsa-production/tools/saludsa-coverage.tools.abl`

- [ ] **Step 1: Create saludsa-services.tools.abl**

Create `examples/saludsa-production/tools/saludsa-services.tools.abl` with these 6 tools:

```
/**
 * Saludsa Service Tools
 * MCP tools for contracts, payments, password reset, refund guidance, and email.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  contractStatus(channel: string = "", isAuthQVerified: boolean = false, sessionId: string) -> {success: boolean, contracts: object, apiError: boolean}
    type: http
    endpoint: "/contractStatus"
    method: POST
    description: "Return contract status details. Contracts include status (Active, Pending, Cancelled, Donated, Tax Relief)."

  sending_contracts(channel: string = "", contractId: string = "", isAuthQVerified: boolean = false, inboundNumber: string = "", outboundNumber: string = "", sessionId: string) -> {success: boolean, contractData: object, apiError: boolean}
    type: http
    endpoint: "/sending-contracts"
    method: POST
    description: "Retrieve and send contract documents."

  pending_payments(channel: string = "", contractId: string = "", sessionId: string) -> {success: boolean, paymentData: object, apiError: boolean}
    type: http
    endpoint: "/pending-payments"
    method: POST
    description: "Return pending payment amounts with full classification and account holder data."

  passwordReset(codigoTarea: string = "", passwordResetType: string = "", sessionId: string) -> {success: boolean, message: string, apiError: boolean}
    type: http
    endpoint: "/passwordReset"
    method: POST
    description: "Reset user password via email or SMS. passwordResetType: 'Email' or 'SMS'."

  steps_for_refund(channel: string = "", sessionId: string) -> {success: boolean, refundSteps: object, eligibleContracts: object, apiError: boolean}
    type: http
    endpoint: "/steps-for-refund"
    method: POST
    description: "Return reimbursement steps and eligibility data."

  sendEmailTemplate(useCaseName: string, codigoTarea: string = "", sessionId: string) -> {success: boolean, message: string}
    type: http
    endpoint: "/sendEmailTemplate"
    method: POST
    description: "Send templated email to the user."
```

- [ ] **Step 2: Create saludsa-coverage.tools.abl**

Create `examples/saludsa-production/tools/saludsa-coverage.tools.abl` with these 2 tools:

```
/**
 * Saludsa Coverage Tools
 * MCP tools for coverage/travel certificate eligibility and generation.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  checkCoverageEligibility(codigoTarea: string = "", certificateType: string, sessionId: string) -> {success: boolean, eligibleContracts: object, apiError: boolean}
    type: http
    endpoint: "/checkCoverageEligibility"
    method: POST
    description: "Check coverage/travel certificate eligibility. certificateType: 'Coverage' or 'Travel'."

  getCoverageCertificate(certificateType: string, contractNumber: string = "", beneficiaryName: string = "", startDate: string = "", endDate: string = "", channel: string = "", inboundNumber: string = "", outboundNumber: string = "", sessionId: string) -> {success: boolean, certificateData: object, apiError: boolean}
    type: http
    endpoint: "/getCoverageCertificate"
    method: POST
    description: "Generate coverage or travel certificate. For travel: startDate/endDate in YYYY-MM-DD, max 61 days apart."
```

- [ ] **Step 3: Format files**

```bash
npx prettier --write examples/saludsa-production/tools/saludsa-services.tools.abl examples/saludsa-production/tools/saludsa-coverage.tools.abl
```

### Task 4: Create transfer, zendesk, refund, and misc tool registries

**Files:**

- Create: `examples/saludsa-production/tools/saludsa-transfer.tools.abl`
- Create: `examples/saludsa-production/tools/saludsa-zendesk.tools.abl`
- Create: `examples/saludsa-production/tools/saludsa-refund.tools.abl`
- Create: `examples/saludsa-production/tools/saludsa-misc.tools.abl`

- [ ] **Step 1: Create saludsa-transfer.tools.abl**

Create `examples/saludsa-production/tools/saludsa-transfer.tools.abl` with these 5 tools:

```
/**
 * Saludsa Transfer Tools
 * MCP tools for business hours, task eligibility, data consent, and Vitality.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  validateoutofhours(codigoTarea: string, sessionId: string) -> {success: boolean, isOutsideHours: boolean, message: string}
    type: http
    endpoint: "/validateoutofhours"
    method: POST
    description: "Validate after-hours service availability by queue. Replaces Kore.ai platform API. codigoTarea examples: Autorizaciones, Urgencias, Transferencia_Travel."

  validateTaskEligibility(codigoTarea: string, sessionId: string) -> {success: boolean, isEligible: boolean, activeContracts: object, activeContractsCount: number, apiError: boolean, message: string}
    type: http
    endpoint: "/validateTaskEligibility"
    method: POST
    description: "Check eligibility for business tasks and update Zendesk. codigoTarea: MedicoEnLinea, Urgencias, Autorizaciones, MedicoDomicilio, Transferencia_Dental, TRANSFERENCIA_EXEQUIAL, TransferenciaPca, Transferencia_Travel."

  validarElegibilidadTarea(codigoTarea: string, sessionId: string) -> {success: boolean, isEligible: boolean, apiError: boolean}
    type: http
    endpoint: "/validarElegibilidadTarea"
    method: POST
    description: "Check eligibility using business parameters."

  lpd_consent(userConsent: string, channel: string, sessionId: string) -> {success: boolean}
    type: http
    endpoint: "/lpd-consent"
    method: POST
    description: "Handle user data consent (GDPR/privacy)."

  vitalityCheck(sessionId: string) -> {success: boolean, isActive: boolean}
    type: http
    endpoint: "/vitalityCheck"
    method: POST
    description: "VPMS service check for Vitality wellness program."
```

- [ ] **Step 2: Create saludsa-zendesk.tools.abl**

Create `examples/saludsa-production/tools/saludsa-zendesk.tools.abl` with these 3 tools:

```
/**
 * Saludsa Zendesk Tools
 * MCP tools for creating, updating, and closing Zendesk support tickets.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  create_zendesk_ticket(usecase: string = "new", channel: string = "web", botSessionId: string = "", botUserId: string = "", subject: string = "Nuevo Ticket", comment: string = "", tags: string = "", note: string = "", sessionId: string) -> {success: boolean, ticketId: string}
    type: http
    endpoint: "/create-zendesk-ticket"
    method: POST
    description: "Create Zendesk ticket. usecase enum: new, transer_sac, transfer_sales, transfer_vitality, transfer_authorization, tranfer_emergency, transfer_online_medical."

  update_zendesk_ticket(usecase: string, channel: string = "", transfer_type: string = "", transfer_reason: string = "", lpd_accept: boolean = true, requerimientos_samy: string = "", region: string = "", subject: string = "", note: string = "", publicNote: string = "", status: string = "", client_id: string = "", client_name: string = "", client_email: string = "", client_phone: string = "", requester_name: string = "", requester_email: string = "", new_ticket: string = "", sessionId: string) -> {success: boolean}
    type: http
    endpoint: "/update-zendesk-ticket"
    method: POST
    description: "Update existing Zendesk ticket. usecase enum: user_details, lpd, refund, contract_status, transfer_sac, transfer_sales, transfer_vitality, transfer_authorization, transfer_emergency, transfer_online_medical, transfer_doctor_home, transfer_funeral, transfer_dental, transfer_travel, transfer_pca, refund_status, sending_contract, otp_code, password_reset, pending_payment_amounts, issuance_of_coverage, auth_fail, auth_fail_client, broker_client."

  close_zendesk_ticket(closing_reason: string = "", note: string = "", tags: string = "", sessionId: string) -> {success: boolean}
    type: http
    endpoint: "/close-zendesk-ticket"
    method: POST
    description: "Close Zendesk ticket. closing_reason: self_service, abandonment, transfer_completed, after_hours, error, external_transfer."
```

- [ ] **Step 3: Create saludsa-refund.tools.abl**

Create `examples/saludsa-production/tools/saludsa-refund.tools.abl` with these 3 tools:

```
/**
 * Saludsa Refund Tools
 * MCP tools for refund status, resend settlement, and prioritize refund.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"

  checkRefundStatus(channel: string = "", envelopeNumber: string = "", amount: number = 0, date: string = "", sessionId: string) -> {success: boolean, refunds: object, apiError: boolean}
    type: http
    endpoint: "/checkRefundStatus"
    method: POST
    description: "Get refund status by envelope number (NA-xxxxxx), amount, or date (YYYY-MM-DD)."

  resend_refund_settlement(envelopeNumber: string, sessionId: string) -> {success: boolean, message: string}
    type: http
    endpoint: "/resend-refund-settlement"
    method: POST
    description: "Resend settlement for a settled refund envelope."

  prioritize_refund_zendesk(envelopeNumber: string, sessionId: string) -> {success: boolean, message: string}
    type: http
    endpoint: "/prioritize-refund-zendesk"
    method: POST
    description: "Mark delayed refund as priority in Zendesk."
```

- [ ] **Step 4: Create saludsa-misc.tools.abl**

Create `examples/saludsa-production/tools/saludsa-misc.tools.abl` — placeholder for any tools not in the other registries. Currently empty but the file must exist since project.json references it:

```
/**
 * Saludsa Miscellaneous Tools
 * Reserved for tools that don't fit other registries.
 * Currently empty — all 30 MCP tools are in the other 7 registry files.
 */

TOOLS:
  base_url: "${SALUDSA_MCP_ENDPOINT}"
  auth: basic
  timeout: 45000
  auth_config:
    header_name: "Authorization"
    provider: "${SALUDSA_MCP_AUTH}"
```

- [ ] **Step 5: Format and commit all tool registries**

```bash
npx prettier --write examples/saludsa-production/tools/saludsa-*.tools.abl
```

### Task 5: Create code tool registries (sandbox tools)

**Files:**

- Create: `examples/saludsa-production/tools/code-identity.tools.abl`
- Create: `examples/saludsa-production/tools/code-otp.tools.abl`
- Create: `examples/saludsa-production/tools/code-transfer.tools.abl`
- Create: `examples/saludsa-production/tools/code-misc.tools.abl`

These are sandbox tools (TYPE: sandbox, RUNTIME: javascript) that wrap MCP tool calls with memory management logic.

**CRITICAL:** Before writing these tools, read the full JavaScript source code from the Kore.ai export at `/Users/Thiru/researchWS/Saludsa/app-saludsa_app_temp-09-03-2026-18-07-43.json` under the `codeTools` array. The persisted extraction is at `/Users/Thiru/.claude/projects/-Users-Thiru-researchWS-abl-platform/0d767cb5-9b81-4875-8e6c-3b7f943e617e/tool-results/toolu_016yhQQUUExb4JNL9a2EWv8Y.json`. Port the exact JavaScript logic from the Kore.ai export — do not invent behavior.

- [ ] **Step 1: Create code-identity.tools.abl**

Create `examples/saludsa-production/tools/code-identity.tools.abl` with 3 sandbox tools: `ValidateUserID`, `BrokerIDValidator`, `ClientIDValidator`.

Each tool must:

- Read session memory via `memory.get_content()`
- Call the appropriate MCP endpoint via `axios.post()`
- Write results back to session memory via `memory.set_content()`
- Track retry counters (`invalidCount`, `idInvalidCountBR`, `idInvalidCountC`, `BRNotEligibleCount`)
- Set `userValidation: true` ONLY on successful validation

Port the JavaScript verbatim from the Kore.ai export `codeTools` array. Replace `env.mcp_server_endPoint` with `env.SALUDSA_MCP_ENDPOINT` and `env.mcp_basic_Auth` with `env.SALUDSA_MCP_AUTH`.

- [ ] **Step 2: Create code-otp.tools.abl**

Create `examples/saludsa-production/tools/code-otp.tools.abl` with 3 sandbox tools: `otpGenerator`, `otpValidator`, `OTPFailureSACTransferTool`.

Key behaviors:

- `otpGenerator`: Calls `POST /otpGenerator` with `sessionId`. Simple wrapper.
- `otpValidator`: Calls `POST /otpValidator`. Tracks `otpInvalidCount`. Sets `otpValidated: true` on success. On 2nd failure, updates Zendesk with `usecase: "auth_fail"`.
- `OTPFailureSACTransferTool`: Calls `validateoutofhours` MCP tool (NOT the old Kore.ai platform API). If within hours: sets `handsOffStatus: true`, `queueName: "WhatsappSAC"`, `reason: "El usuario no pudo realizar la autenticación OTP"`. If outside hours: sets `isOutsideBusinessHours: true`, updates Zendesk with `"sac_after_hours"`.

**IMPORTANT:** The original `OTPFailureSACTransferTool` and `HandleServiceFailure` called `platform.kore.ai/agentassist/api/.../operationshours`. Replace ALL such calls with the `validateoutofhours` MCP tool instead.

- [ ] **Step 3: Create code-transfer.tools.abl**

Create `examples/saludsa-production/tools/code-transfer.tools.abl`.

**IMPORTANT — Design decision:** The spec (Section 5.3) says these 4 tools should be **FLOW logic** (simple SET statements in agent FLOW steps), NOT sandbox tools. However, `saveTransferSAC` has non-trivial queue name computation based on menu selection, channel, and intent — it's not just a flat SET. Therefore:

- `saveTransferSAC`: **Sandbox tool** — the queue routing logic (mapping menu_number + channel → queueName/businessUnit) is complex enough to warrant a sandbox tool. Port the JavaScript from the Kore.ai export. The tool reads parameters, computes queue name based on menu selection and channel mapping, and writes to `transfer_metadata` memory store: `queueName`, `businessUnit`, `handsOffStatus: true`, `reason`, `ticketId`, `externalPhoneNumber`, `sacMessage`.
- `saveTransferSales`: **Sandbox tool** — has queue/business unit computation based on role + channel. Port from Kore.ai export. Writes sales queue and business unit to `transfer_metadata`.
- `saveTransferToVitality`: **Flow-compatible but kept as sandbox** for consistency. Writes Vitality queue metadata. Port from Kore.ai export.
- `saveDrSaludMetaData`: **Sandbox tool** — writes Dr. Salud use case metadata with queue assignment logic based on useCaseName. Port from Kore.ai export.

All 4 tools follow the sandbox format:

```
tool_name(params) -> {success: boolean}
  type: sandbox
  runtime: javascript
  description: "..."
  code: |
    // Port from Kore.ai codeTools array
    // Access params via $paramName
    // Read memory: const data = await memory.get_content("storeName");
    // Write memory: await memory.set_content("storeName", value);
    // Return result: return { success: true };
```

Port the JavaScript verbatim from the Kore.ai export `codeTools` array. Key replacements:

- `env.mcp_server_endPoint` → `env.SALUDSA_MCP_ENDPOINT`
- `env.mcp_basic_Auth` → `env.SALUDSA_MCP_AUTH`
- All `platform.kore.ai/agentassist/api/...` calls → `validateoutofhours` MCP tool call

- [ ] **Step 4: Create code-misc.tools.abl**

Create `examples/saludsa-production/tools/code-misc.tools.abl` with 2 sandbox tools:

- `HandleServiceFailure`: Global API failure handler. Calls `validateoutofhours` MCP tool (replacing the old Kore.ai platform API). If within hours: sets `handsOffStatus: true` with queue routing and reason `"Fallo de API"`. If outside hours: sets `isOutsideBusinessHours: true` and updates Zendesk.
- `HandlePriorityProductTransfer`: Evaluates `priorityTransfer` flag (XPR, PCA, SAC, FIDEVAL, TRK) and sets appropriate transfer metadata (queue, business unit, handoff status).

**Note:** `SendMessageWhatsapp` is NOT ported — documented in unimplemented-gaps.md (requires WhatsApp channel adapter). `ValidacionFueradeHorario` is NOT ported — replaced by `validateoutofhours` MCP tool.

- [ ] **Step 5: Format and commit code tools**

```bash
npx prettier --write examples/saludsa-production/tools/code-*.tools.abl
```

---

## Chunk 3: Supervisor Agent

### Task 6: Create Samy Supervisor

**Files:**

- Create: `examples/saludsa-production/agents/samy_supervisor.agent.abl`

**Reference:** Read `examples/travel/agents/traveldesk_supervisor.agent.abl` and `examples/telco/agents/noc_supervisor.agent.abl` for ABL supervisor patterns before writing this file.

- [ ] **Step 1: Write samy_supervisor.agent.abl**

Create `examples/saludsa-production/agents/samy_supervisor.agent.abl` with the complete supervisor definition. This agent:

1. Routes using a 4-level priority cascade (HANDOFF rules, first-match-wins)
2. Never answers users directly — only routes
3. Enforces validation before intent routing on WhatsApp/Voice
4. Uses pipeline model (qwen35-a3b-35b) for initial routing with short-circuit

The complete spec for this agent is in the design spec Section 7.1. Include ALL of:

- SUPERVISOR, VERSION, DESCRIPTION
- GOAL (route user messages, never answer directly, enforce validation on WA/Voice)
- PERSONA (Samy, Ecuadorian Spanish formal register)
- EXECUTION (model: gpt-4.1, temperature: 0.1, top_p: 0.7, max_tokens: 9999, max_iterations: 5, inline_gather: true, pipeline config)
- MEMORY (all 11 session variables from spec Section 7.1)
- TEMPLATES (welcome, outside_business_hours)
- ON_START (RESPOND: TEMPLATE(welcome))
- HANDOFF (all 16 rules across 4 levels — exact WHEN conditions and CONTEXT/RETURN values from spec)
- ESCALATE with full 20-field context_for_human (ALL fields from spec Section 9.2):

  ```
  ESCALATE:
    triggers:
      - WHEN: handsOffStatus == true
        REASON: "Agent handoff flag set"
        PRIORITY: critical
        TAGS: [agent_handoff]
      - WHEN: routing_failures >= 3
        REASON: "Multiple routing failures"
        PRIORITY: high

    context_for_human:
      - conversationSummary       # LLM-generated
      - conversationHistory       # LLM-generated
      - sac_transfer_menu         # LLM-generated (menu selection)
      - reason                    # from session.reason
      - ticketId                  # from session.ticketId
      - externalPhoneNumber       # from session.externalPhoneNumber
      - queueName                 # from session.queueName
      - businessUnit              # from session.businessUnit
      - agenticSessionId          # from session.sessionId
      - highPriorityTransfer      # from session.highPriorityTransfer
      - beneficiaryId             # from session.beneficiaryId
      - beneficiaryName           # from session.beneficiaryName
      - whatsAppLinkNumber        # from session.whatsAppLinkNumber
      - customerName              # from session.customerName
      - userPhoneNumber           # from session.userPhoneNumber
      - userId                    # from session.userId
      - userEmail                 # from session.userEmail
      - sacMessage                # from session.sacMessage
      - memberShipType            # from session.memberShipType
      - customerDetails           # from session.customerDetails
  ```

- ON_ERROR (routing_failure → retry 1 → ESCALATE)
- COMPLETE (handoff_successful → empty response)

- [ ] **Step 2: Format**

```bash
npx prettier --write examples/saludsa-production/agents/samy_supervisor.agent.abl
```

---

## Chunk 4: Entry Gateway Agents

### Task 7: Create Client Entry Gateway

**Files:**

- Create: `examples/saludsa-production/agents/client_entry_gateway.agent.abl`

**Reference:** Read `examples/travel/agents/authentication.agent.abl` for FLOW-based auth pattern.

- [ ] **Step 1: Write client_entry_gateway.agent.abl**

This agent validates client identity on WhatsApp/Voice via cédula/passport. Full FLOW specification is in design spec Section 8.1.

Include ALL of:

- AGENT, VERSION: "1.0", DESCRIPTION
- GOAL: Validate user identity via cédula/passport before allowing service access
- PERSONA: Identity validation specialist, formal Spanish, never mentions roles/validations to user
- EXECUTION: temperature: 0.3, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true
- LIMITATIONS: Cannot skip validation steps, must follow exact flow, must not mention roles to user
- TOOLS: ValidateUserID (code-identity), HandleServiceFailure (code-misc), userValidation (saludsa-identity)
- MEMORY: session variables (userType, userRole, invalidCount, userValidation, priorityTransfer, errorMessage, customerDetails, contractNumber, ticketId, timeSlot, title, surName)
- FLOW: 7 steps from spec (pre_check → greet_and_ask_cedula → validate_id → check_priority → validation_success / non_client_offer / session_closed)
- global_digressions: hablar_con_agente → ESCALATE
- ON_ERROR: tool_error → HandleServiceFailure → ESCALATE
- COMPLETE: userValidation == true OR closeConversation == "yes"

**Exact Spanish messages:**

- Greeting: "Hola, soy Samy, su asistente virtual de Saludsa.\n¿Me puede proporcionar su cédula o pasaporte?\nLa conversación se almacenará y monitoreará por seguridad."
- Invalid ID (retry): "Proporcione el número de identificación válido / número de pasaporte"
- Session closed (2 fails): "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante."
- Success: "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?"
- Non-client: "¿Quieres comprar un plan?"
- Broker on wrong number: "Este número está asociado a un perfil de Broker. Por favor utilice el número de WhatsApp correspondiente."

### Task 8: Create Broker Entry Gateway

**Files:**

- Create: `examples/saludsa-production/agents/broker_entry_gateway.agent.abl`

- [ ] **Step 1: Write broker_entry_gateway.agent.abl**

This agent validates brokers/business representatives via a 3-step chain: Broker ID → OTP → Client ID. Full FLOW specification is in design spec Section 8.2.

Include ALL of:

- AGENT, VERSION: "1.0", DESCRIPTION
- GOAL: Validate broker identity through 3-step chain before allowing service access
- PERSONA: Identity validation for brokers, formal Spanish, never mentions internal validations
- EXECUTION: temperature: 0.1, top_p: 0.5, max_tokens: 10000, max_iterations: 20 (14-step flow), inline_gather: true
- LIMITATIONS: Intent routing disabled until full 3-step chain completes, must not route to any other agent during validation
- TOOLS: BrokerIDValidator, ClientIDValidator (code-identity), otpGenerator, otpValidator, OTPFailureSACTransferTool (code-otp), HandleServiceFailure (code-misc), userValidation (saludsa-identity)
- MEMORY: session variables (userType, userRole, userValidation, idInvalidCountBR, otpInvalidCount, idInvalidCountC, BRNotEligibleCount, priorityTransfer, timeSlot, title, surName)
- FLOW: 14 steps from spec (pre_check → role_identification → ask_broker_id → validate_broker_id → generate_otp → ask_otp → validate_otp → ask_client_id → validate_client_id → check_client_priority → validation_success / broker_session_closed / client_session_closed / portfolio_closed)
- CONSTRAINTS: userValidation != true IMPLIES intent_routing_disabled
- global_digressions: hablar_con_agente → ESCALATE
- ON_ERROR: tool_error → HandleServiceFailure → ESCALATE
- COMPLETE: userValidation == true OR closeConversation == "yes"

**CRITICAL:** `userValidation = true` is ONLY set after Step 3 (ClientIDValidator) succeeds. Broker ID + OTP alone do NOT mark the user as validated.

**Exact Spanish messages:**

- Role menu (WhatsApp): "{timeSlot}! Para continuar, por favor confirme su rol seleccionando una de las siguientes opciones:\n1. Representante de Negocios (RN)\n2. Broker\nIndique el número correspondiente a su rol, o escríbalo directamente."
- Greeting: "Hola, {title}. {surName}, me puede proporcionar su cedula / pasaporte? La conversación se almacenará y monitoreará por seguridad."
- Broker ID retry: "Proporcione un número de identificación de corredor/pasaporte válido"
- OTP prompt: "Hemos enviado un código OTP a su número registrado. Por favor, ingrese el código."
- OTP retry: "El código OTP no es válido. Por favor, intente nuevamente."
- Client ID prompt: "Por favor, indíqueme la identificación o número de contrato de su cliente para quien desea realizar la gestión, para continuar de manera segura con el servicio."
- Client ID retry: "Proporcione un número de identificación de cliente/pasaporte válido"
- Not in portfolio retry: "La identificación ingresada no corresponde a su cartera de clientes. Por favor, intente nuevamente."
- Not in portfolio closed: "Lamentablemente, la identificación ingresada no corresponde a su cartera de clientes y se ha superado el número máximo de intentos permitidos. Para cuidar la seguridad de la información, esta conversación se ha cerrado de forma automática. Por favor, inténtelo nuevamente más tarde"
- Session closed: "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante."
- Validation success: "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?"

- [ ] **Step 2: Format both gateway agents**

```bash
npx prettier --write examples/saludsa-production/agents/client_entry_gateway.agent.abl examples/saludsa-production/agents/broker_entry_gateway.agent.abl
```

---

## Chunk 5: Service Agents — Contracts & Payments

### Task 9: Create Contract Data Assistant

**Files:**

- Create: `examples/saludsa-production/agents/contract_data_assistant.agent.abl`

- [ ] **Step 1: Write contract_data_assistant.agent.abl**

**Purpose:** Retrieves plan details and contract status after security question auth on WhatsApp/Voice. Design spec Section 8.3.

EXECUTION: temperature: 0.1, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

TOOLS: getSecurityQuestions (saludsa-identity), contractStatus (saludsa-services), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc)

FLOW: check_role_and_channel → security_question_auth → retrieve_contracts → display_contracts / not_eligible

Key rules:

- Non-Client/Payer → "En este momento, su perfil no tiene acceso a este tipo de información o servicio. ¿Le puedo servir en algo adicional?"
- WEB/iOS/ANDROID → skip security questions, go straight to retrieve_contracts
- WhatsApp/Voice Holder/Beneficiary → security question auth (2 attempts, re-trigger on first fail)
- Broker/BR on WhatsApp → skip security questions
- Display max 5 contracts, prioritized: Active → Pending → Cancelled
- Never mention Zendesk tickets to user
- Must not ask user for channel or role — read from session memory
- All communication in Spanish only

### Task 10: Create Contract Sending Agent

**Files:**

- Create: `examples/saludsa-production/agents/contract_sending.agent.abl`

- [ ] **Step 1: Write contract_sending.agent.abl**

**Purpose:** Sends contract document copies after security question auth. Design spec Section 8.4.

EXECUTION: temperature: 0.2, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

TOOLS: getSecurityQuestions (saludsa-identity), sending_contracts (saludsa-services), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc)

FLOW: check_role → check_channel → security_question_auth → retrieve_contracts → select_contract → deliver_contract

Key rules:

- Payer/Non-Client → cannot receive contracts, end conversation
- WEB/iOS/ANDROID → skip security questions
- Broker/BR on WhatsApp → skip security questions, proceed directly to sending-contracts
- Role mapping: "Representante de Negocios", "RN" → "Business Representative"
- Security question with "Antes de continuar, necesito hacerle una pregunta de validación para proteger su información."
- If multiple contracts → let user select
- Deliver via email or inline based on channel
- Do NOT show URLs as plain text

### Task 11: Create Pending Payments Agent

**Files:**

- Create: `examples/saludsa-production/agents/pending_payments.agent.abl`

- [ ] **Step 1: Write pending_payments.agent.abl**

**Purpose:** Payment/billing inquiries with OTP auth. Full FLOW in design spec Section 8.5.

EXECUTION: temperature: 0.3, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

TOOLS: otpGenerator, otpValidator, OTPFailureSACTransferTool (code-otp), pendingPaymentOtp (saludsa-otp), pending_payments (saludsa-services), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc)

FLOW (8 steps from spec): check_channel → otp_phone_validation → otp_generate → otp_gather → otp_validate → retrieve_payments → display_payments → closing_question

Key rules:

- WEB/iOS/ANDROID → skip OTP, go to retrieve_payments
- WhatsApp/Voice: pendingPaymentOtp → otpGenerator → gather OTP → otpValidator
- OTP failure (2 attempts) → OTPFailureSACTransferTool → ESCALATE
- Categorize payments: all-clear, single-pending, single-in-process, multiple-pending, multiple-in-process, mixed
- Format plan names: add space after colon if missing (":3" → ": 3")
- Include global_digressions for hablar_con_agente
- Never skip tool calls — MUST always trigger corresponding tool

### Task 12: Create Password Reset Agent

**Files:**

- Create: `examples/saludsa-production/agents/password_reset.agent.abl`

- [ ] **Step 1: Write password_reset.agent.abl**

**Purpose:** Password reset with role eligibility checks and OTP. Design spec Section 8.6.

EXECUTION: temperature: 0.3, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

TOOLS: otpGenerator, otpValidator (code-otp), validate_otp_client (saludsa-otp), passwordReset (saludsa-services), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc)

FLOW: check_role → otp_auth (WhatsApp/Voice only) → ask_delivery_preference → reset_password → confirm

Key rules:

- Holder → can reset password
- Beneficiary → "Contacte al titular de la cuenta para el restablecimiento de contraseña"
- Payer → "El restablecimiento de contraseña no aplica" → end
- Non-Client → "El restablecimiento no aplica" → redirect to onboarding
- Broker/BR → can initiate for client
- WEB/iOS/ANDROID → skip OTP
- Ask delivery: email or SMS
- Mask email and phone in response (e.g., t***@gmail.com, +593***5678)
- OTP failure → OTPFailureSACTransferTool → ESCALATE

- [ ] **Step 2: Format all service agents**

```bash
npx prettier --write examples/saludsa-production/agents/contract_data_assistant.agent.abl examples/saludsa-production/agents/contract_sending.agent.abl examples/saludsa-production/agents/pending_payments.agent.abl examples/saludsa-production/agents/password_reset.agent.abl
```

---

## Chunk 6: Service Agents — Refunds & Coverage

### Task 13: Create Refund Guidance Agent

**Files:**

- Create: `examples/saludsa-production/agents/refund_guidance.agent.abl`

- [ ] **Step 1: Write refund_guidance.agent.abl**

**Purpose:** Step-by-step medical expense reimbursement guidance. Design spec Section 8.7.

EXECUTION: temperature: 0.1, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

PERSONA: Agente de Guía de Reembolsos de Saludsa. Guía al usuario paso a paso en el proceso de reembolso de gastos médicos, adaptándose a su rol, elegibilidad de contrato y canal de comunicación.

TOOLS: steps_for_refund (saludsa-services), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc)

FLOW: check_role → get_eligible_contracts → select_contract → ask_display_preference → display_steps → closing_question

Key rules:

- Payer/Non-Client → "En este momento, su perfil no tiene acceso a este tipo de servicio."
- Call steps-for-refund to get eligible contracts
- If user specifies contract number → check if in response, proceed if found
- Ask: step-by-step or summary?
- Display reimbursement steps by category (lab, medications, therapies, procedures, consultations, hospital)
- MUST include tutorial video URLs/links even in summary mode
- Display one step at a time (conversational), NOT all at once
- Do not add information from own knowledge
- Do not mention Zendesk tickets to user
- Do not provide emojis
- Update Zendesk throughout flow
- If API fails → HandleServiceFailure → ESCALATE

### Task 14: Create Refund Status Agent

**Files:**

- Create: `examples/saludsa-production/agents/refund_status.agent.abl`

- [ ] **Step 1: Write refund_status.agent.abl**

**Purpose:** Simple transfer agent — immediately transfers to SAC for refund status. Does NOT perform any lookup. Design spec Section 8.8.

EXECUTION: temperature: 0.3, top_p: 0.6, max_tokens: 10000, max_iterations: 5, inline_gather: true

TOOLS: saveTransferSAC (code-transfer)

FLOW (1 step):

```
entry_point: transfer
steps:
  - transfer

transfer:
  REASONING: false
  CALL: saveTransferSAC(sacReason: "refund_status", usecaseName: "refund_status")
  ON_SUCCESS:
    SET: handsOffStatus = true
    RESPOND: "Le transfiero con un agente para consultar el estado de su reembolso."
    THEN: ESCALATE
  ON_FAIL:
    RESPOND: "No pudimos procesar su solicitud. Por favor intente más tarde."
    THEN: COMPLETE
```

### Task 15: Create Coverage Certificates Agent

**Files:**

- Create: `examples/saludsa-production/agents/coverage_certificates.agent.abl`

- [ ] **Step 1: Write coverage_certificates.agent.abl**

**Purpose:** Generate coverage and travel certificates. Most complex agent. Design spec Section 8.9.

EXECUTION: temperature: 0.3, top_p: 0.5, max_tokens: 10000, max_iterations: 20 (complex multi-step flow), inline_gather: true

TOOLS: getSecurityQuestions (saludsa-identity), checkCoverageEligibility, getCoverageCertificate (saludsa-coverage), sendEmailTemplate (saludsa-services), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc), saveTransferSAC (code-transfer)

FLOW: check_role → security_auth → identify_cert_type → check_eligibility → select_contract → select_beneficiary → gather_dates (travel only) → generate_certificate → deliver → closing_question

Key rules:

- Security question auth on WhatsApp/Voice (Holder/Beneficiary only)
- WEB/iOS/ANDROID → skip security questions
- If user doesn't specify coverage vs travel → ask: "¿Qué certificado desea? Cobertura o Viaje"
- Call checkCoverageEligibility with certificateType
- If eligible contracts → present list, let user select
- If multiple beneficiaries on selected contract → present NombreCompleto list (but NOT in eligibility step)
- "wife"/"husband" → match "spouse" as RelacionDependiente
- "1", "1st", "first" → select first item from displayed list
- For Travel: gather startDate and endDate (YYYY-MM-DD, max 61 days apart, default current year)
- Call getCoverageCertificate to generate
- Deliver via sendEmailTemplate or inline
- If any tool returns `success: false` → call saveTransferSAC → ESCALATE
- If API error → HandleServiceFailure → ESCALATE
- Check business hours for transfers
- Never display "Gracias por chatear" after end of conversation
- Follow steps in sequential order, do not skip or alter

CONSTRAINTS:

```
pre_certificate:
  - REQUIRE travel_end_date - travel_start_date <= 61
    ON_FAIL: "El certificado de viaje no puede exceder 61 días desde la fecha de inicio."
  - REQUIRE NOT (userRole IN ["Payer", "Non Client"])
    ON_FAIL: "Este servicio no está disponible para su perfil."
```

- [ ] **Step 2: Format all refund and coverage agents**

```bash
npx prettier --write examples/saludsa-production/agents/refund_guidance.agent.abl examples/saludsa-production/agents/refund_status.agent.abl examples/saludsa-production/agents/coverage_certificates.agent.abl
```

---

## Chunk 7: Transfer & Complex Agents

### Task 16: Create Transfer Services (Dr. Salud)

**Files:**

- Create: `examples/saludsa-production/agents/transfer_services.agent.abl`

- [ ] **Step 1: Write transfer_services.agent.abl**

**Purpose:** Handles 5 medical service use cases under Dr. Salud. Design spec Section 8.10.

EXECUTION: temperature: 0.3, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

PERSONA: Agente de Servicios Dr. Salud, el asistente virtual unificado para servicios de Dr. Salud.

TOOLS: validateTaskEligibility, validateoutofhours (saludsa-transfer), sendEmailTemplate (saludsa-services), update_zendesk_ticket (saludsa-zendesk), saveDrSaludMetaData, saveTransferSales (code-transfer), HandleServiceFailure (code-misc)

5 use cases (each with independent FLOW branch):

| Use Case                  | codigoTarea     | Flow                                                                    |
| ------------------------- | --------------- | ----------------------------------------------------------------------- |
| DRSALUDAUTORIZATION       | Autorizaciones  | Eligibility → Zendesk ticket → SAC handoff                              |
| DRSALUDEMERGENCY          | Urgencias       | Eligibility → Zendesk ticket → SAC handoff                              |
| ONLINEMEDICALCONSULTATION | MedicoEnLinea   | Eligibility → redirect to telemedicine                                  |
| DOCTORHOMEVISIT           | MedicoDomicilio | Eligibility → WhatsApp redirect text (actual interactive button is gap) |
| TRANSFERTOSALES           | N/A             | Direct transfer to sales queue                                          |

Key rules:

- Must identify useCaseName BEFORE calling any tool
- Each use case has independent step numbering
- Variables from one use case must NOT be reused in another
- If `activeContractsCount > 1` AND use case is NOT DOCTORHOMEVISIT → ask user to choose beneficiary
- Spanish only, do not mention Zendesk tickets
- Do NOT trigger Agent Handoff after tool execution unless workflow explicitly says so
- DOCTORHOMEVISIT: never send default closing messages if flow already sent final message
- API failure → HandleServiceFailure → ESCALATE

### Task 17: Create Other Services Agent

**Files:**

- Create: `examples/saludsa-production/agents/other_services.agent.abl`

- [ ] **Step 1: Write other_services.agent.abl**

**Purpose:** Dental coverage, funeral services, travel assistance. Design spec Section 8.11.

EXECUTION: temperature: 0.3, top_p: 0.5, max_tokens: 10000, max_iterations: 15, inline_gather: true

TOOLS: validarElegibilidadTarea, validateTaskEligibility (saludsa-transfer), update_zendesk_ticket (saludsa-zendesk), HandleServiceFailure (code-misc), saveTransferSAC (code-transfer)

3 independent use cases:

| Use Case                   | codigoTarea            | Partner                  | Contact                                    |
| -------------------------- | ---------------------- | ------------------------ | ------------------------------------------ |
| DENTAL_COVERAGE            | Transferencia_Dental   | Confident                | Phone: 0985387985, WhatsApp: +593985387985 |
| FUNERAL_SERVICE            | TRANSFERENCIA_EXEQUIAL | Grupo Jardines del Valle | Phone: (02) 2550290                        |
| TRANSFER_TO_SALUDSA_TRAVEL | Transferencia_Travel   | Assist Card              | WhatsApp: +54 9 11 2703-9665               |

Key rules:

- Each use case has its own independent step sequence starting at STEP 1
- Variables from one use case must NOT be reused in another
- Dental: Payer/Non-Client → "Este beneficio no está disponible para su perfil"
- Do not call any tool until useCaseName is finalized
- Spanish only, do not mention Zendesk tickets
- API failure → HandleServiceFailure → ESCALATE

### Task 18: Create Transfer To Vitality Agent

**Files:**

- Create: `examples/saludsa-production/agents/transfer_to_vitality.agent.abl`

- [ ] **Step 1: Write transfer_to_vitality.agent.abl**

**Purpose:** Transfer Vitality wellness program inquiries. Design spec Section 8.12.

EXECUTION: temperature: 0.3, top_p: 1.0, max_tokens: 10000, max_iterations: 10, inline_gather: true

TOOLS: saveTransferToVitality (code-transfer), validateoutofhours (saludsa-transfer)

FLOW: save_metadata → check_hours → transfer_or_inform

Key rules:

- Call saveTransferToVitality first
- Check business hours via validateoutofhours
- If within hours → set handsOffStatus: true → ESCALATE (Agent Handoff)
- If outside hours → display outside-hours message, offer alternative
- If handsOffStatus already true → do NOT generate any user message, trigger handoff silently
- Do not ask reason when triggered, just proceed
- Do not mention Zendesk tickets

### Task 19: Create Transfer To SAC Agent

**Files:**

- Create: `examples/saludsa-production/agents/transfer_to_sac.agent.abl`

- [ ] **Step 1: Write transfer_to_sac.agent.abl**

**Purpose:** Customer service escalation with intent matching and menu. Design spec Section 8.13.

EXECUTION: temperature: 0.0, top_p: 0.6, max_tokens: 10000, max_iterations: 15, inline_gather: true

TOOLS: saveTransferSAC, saveTransferSales, saveTransferToVitality, saveDrSaludMetaData (code-transfer), validateoutofhours (saludsa-transfer), update_zendesk_ticket (saludsa-zendesk)

FLOW: check_handoff → ask_reason → match_intent → present_menu → route_selection

Key rules:

- If handsOffStatus already true → silent handoff (no user message)
- Ask user's reason for wanting to speak with an agent
- Match against predefined intent list: transaction status, complaints, coverage info, contract updates, cancellations, reactivation, etc.
- If intent matches → transfer immediately with appropriate metadata
- If no match (attempt 1) → ask again
- If no match (attempt 2) → present 4-option menu:
  1. Dr. Salud
  2. Servicio al Cliente (SAC)
  3. Vitality
  4. Ventas
- Voice channel has different menu structure with submenus
- Check business hours before transfer
- Outside hours → display hours message
- Do not provide the intent list to user
- Even if user says "manager" / "customer support", ask reason first

### Task 20: Create PCA XPR Transfer Agent

**Files:**

- Create: `examples/saludsa-production/agents/pca_xpr_transfer.agent.abl`

- [ ] **Step 1: Write pca_xpr_transfer.agent.abl**

**Purpose:** Priority product routing (XPR, PCA, JAPI, Hunter, Fideval, TRK/TRANKI). Design spec Section 8.14.

EXECUTION: temperature: 0.1, top_p: 0.5, max_tokens: 10000, max_iterations: 10, inline_gather: true

TOOLS: saveTransferSAC (code-transfer), create_zendesk_ticket (saludsa-zendesk), HandlePriorityProductTransfer (code-misc)

FLOW: check_handoff → detect_product → route_by_channel → provide_contact_or_transfer

Products:

- XPR (Experience): Voice → call transfer; Digital → contact info
- PCA/ServiAlamo: Transfer to SAC with PCA queue
- Fideval: Phone: 1-800-022945301, WhatsApp: +593985613739
- TRK/TRANKI: Contact info
- JAPI/Hunter: Contact info

Key rules:

- If handsOffStatus already true → silent handoff
- Voice → set transfer metadata → ESCALATE
- Digital → display partner contact → farewell
- Farewell: "Ha sido un placer asistirle. Que tenga un excelente {timeSlot}."
- Do not mention Zendesk tickets or validations

- [ ] **Step 2: Format all transfer and complex agents**

```bash
npx prettier --write examples/saludsa-production/agents/transfer_services.agent.abl examples/saludsa-production/agents/other_services.agent.abl examples/saludsa-production/agents/transfer_to_vitality.agent.abl examples/saludsa-production/agents/transfer_to_sac.agent.abl examples/saludsa-production/agents/pca_xpr_transfer.agent.abl
```

---

## Chunk 8: System Agents, Locales & Gaps

### Task 21: Create Fallback and Farewell Handlers

**Files:**

- Create: `examples/saludsa-production/agents/fallback_handler.agent.abl`
- Create: `examples/saludsa-production/agents/farewell_handler.agent.abl`

- [ ] **Step 1: Write fallback_handler.agent.abl**

**Purpose:** Handle unrecognized/out-of-scope inputs. Design spec Section 8.15.

EXECUTION: temperature: 0.1, top_p: 0.3, max_tokens: 10000, max_iterations: 10, inline_gather: true

TOOLS: update_zendesk_ticket (saludsa-zendesk), saveTransferSAC, saveTransferSales, saveTransferToVitality, saveDrSaludMetaData (code-transfer), validateoutofhours (saludsa-transfer)

FLOW: check_handoff → ask_clarification (2 retries) → present_menu → route_selection

Key rules:

- If handsOffStatus already true → ESCALATE silently
- Provide exactly 2 retries before showing menu
- After retries → update Zendesk ticket → present 4-option menu:
  1. Dr. Salud
  2. Servicio al Cliente (SAC)
  3. Vitality
  4. Ventas
- Route based on selection → saveTransfer\* → ESCALATE
- Check business hours before transfer
- Must not answer questions from own knowledge
- Outside hours → display hours message

Messages:

- "No estoy seguro de entender su solicitud. ¿Podría reformular su pregunta?"
- Menu: "Le puedo ayudar con las siguientes opciones:\n1. Dr. Salud\n2. Servicio al Cliente (SAC)\n3. Vitality\n4. Ventas\n\nPor favor seleccione una opción."

- [ ] **Step 2: Write farewell_handler.agent.abl**

**Purpose:** Graceful conversation closure. Design spec Section 8.16.

EXECUTION: temperature: 0.2, top_p: 1.0, max_tokens: 7000, max_iterations: 5, inline_gather: true

TOOLS: close_zendesk_ticket (saludsa-zendesk)

FLOW (1 step):

```
entry_point: farewell
steps:
  - farewell

farewell:
  REASONING: false
  CALL: close_zendesk_ticket(closing_reason: "self_service", sessionId: session.sessionId)
  ON_SUCCESS:
    RESPOND: "Ha sido un placer asistirle. ¡Que tenga un excelente {timeSlot}!"
    SET: closeConversation = "yes"
    THEN: COMPLETE
```

CONSTRAINTS:

- REQUIRE previous_system_message_was_offer == true → "Farewell only triggers after an assistance offer"
- REQUIRE NOT in_auth_flow → "Never trigger during authentication"
- REQUIRE NOT in_data_collection → "Never trigger during data collection"

LIMITATIONS:

- Must use {timeSlot} from session memory for time-appropriate greeting
- Must close Zendesk ticket before farewell message

- [ ] **Step 3: Format system agents**

```bash
npx prettier --write examples/saludsa-production/agents/fallback_handler.agent.abl examples/saludsa-production/agents/farewell_handler.agent.abl
```

### Task 22: Create Spanish locale files

**Files:**

- Create: 17 JSON files under `examples/saludsa-production/locales/es/`

- [ ] **Step 1: Create locale files for all agents**

Create one locale JSON file per agent under `locales/es/`. Each file contains the agent's user-facing Spanish strings (greetings, error messages, prompts, menus, partner contact info).

For each agent, extract all RESPOND strings from the FLOW and organize them as key-value pairs:

Example format (`locales/es/client_entry_gateway.json`):

```json
{
  "greeting": "Hola, soy Samy, su asistente virtual de Saludsa.\n¿Me puede proporcionar su cédula o pasaporte?\nLa conversación se almacenará y monitoreará por seguridad.",
  "invalid_id_retry": "Proporcione el número de identificación válido / número de pasaporte",
  "session_closed": "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante.",
  "validation_success": "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?",
  "non_client_offer": "¿Quieres comprar un plan?",
  "broker_wrong_number": "Este número está asociado a un perfil de Broker. Por favor utilice el número de WhatsApp correspondiente.",
  "api_error": "Lo sentimos, tenemos dificultades técnicas. Por favor intente más tarde."
}
```

Create similar locale files for all 17 agents, extracting every Spanish string from the FLOW/RESPOND definitions in each agent's spec.

- [ ] **Step 2: Format locale files**

```bash
npx prettier --write examples/saludsa-production/locales/es/*.json
```

### Task 23: Create unimplemented gaps document

**Files:**

- Create: `examples/saludsa-production/docs/unimplemented-gaps.md`

- [ ] **Step 1: Write unimplemented-gaps.md**

Create `examples/saludsa-production/docs/unimplemented-gaps.md`:

```markdown
# Saludsa Production Port — Unimplemented Gaps

Items that could not be fully implemented in the ABL DSL port. Each gap documents the original Kore.ai behavior, why it can't be ported, and the recommended path forward.

## 1. Contact Center Adapter (In-Flight)

**Original:** Kore.ai ContactCenter API (`CC_streamId`, `CC_accountId`) routes ESCALATE events to human agent queues (WhatsAppSAC, Voz_Emergencias, Chat Portal SAC, etc.).

**Current state:** ESCALATE events carry the full context (queueName, reason, ticketId, conversationSummary, conversationHistory, externalPhoneNumber, businessUnit, sacMessage, customerName, customerDetails, etc.) but the actual CC adapter that calls the Kore.ai ContactCenter API is being built separately.

**Impact:** Agents correctly trigger ESCALATE with all required context. The handoff to a human agent will not work until the CC adapter is connected.

**Path forward:** CC adapter integration is in-flight. Once connected, ESCALATE events will route to the correct queue.

## 2. Channel Adapters

**Original:** Kore.ai XO Bot handles WhatsApp (via Infobip), Voice (SIP), Web widget, iOS/Android SDK integration.

**Current state:** ABL agents reference `session.channel` for channel-aware behavior, but the actual channel adapters that receive webhook/API calls and normalize them to ABL session context are not part of this port.

**Impact:** Agents have correct channel branching logic. They will work correctly when channel adapters feed them the right `session.channel`, `session.phoneNumber`, etc.

**Path forward:** Channel adapter implementation is a separate platform infrastructure effort.

## 3. SendMessageWhatsapp (Direct Infobip API)

**Original:** The `SendMessageWhatsapp` code tool calls Infobip API (`l3wl15.api.infobip.com/whatsapp/1/message/interactive/url-button`) to send WhatsApp interactive button messages for Doctor Home Visit. It sends a rich message with a URL button that redirects the user to the Ayumed WhatsApp number.

**Current state:** The Transfer_Services agent's DOCTORHOMEVISIT flow RESPONDS with the redirect text, but cannot send the actual WhatsApp interactive button. The interactive button delivery requires the WhatsApp channel adapter.

**Impact:** Doctor Home Visit users on WhatsApp will see a text message with the redirect info instead of a clickable interactive button.

**Path forward:** Implement in the WhatsApp channel adapter. When the agent responds with a DOCTORHOMEVISIT message, the adapter should convert it to a WhatsApp interactive URL button message via Infobip/Twilio.

## 4. Pre-Processor Auto-Validation for Web/iOS/Android

**Original:** Every Kore.ai agent has a JavaScript pre-processor that auto-validates digital channel users using `metadata.identificacion_app_web` (the user's cédula from the app login). This runs before the agent prompt is evaluated.

**Current state:** ABL agents check `session.channel` and skip validation for digital channels. However, the auto-validation (calling `POST /validateUser` with the pre-authenticated cédula) is not performed by the agents — it should be done by the channel adapter.

**Impact:** Digital channel users will have `session.userValidation` set by the channel adapter, not by the agent. The agent's skip-validation logic works correctly.

**Path forward:** The Web/iOS/Android channel adapter should call `POST /validateUser` with `session.identificacion_app_web` at session start and set `session.userValidation = true`, `session.userRole`, etc.

## 5. PII Masking

**Original:** The Password Reset agent masks email and phone in responses (e.g., `t***@gmail.com`, `+593***5678`). Kore.ai has built-in PII configuration.

**Current state:** ABL has no built-in PII detection or masking. The Password Reset agent's PERSONA instructs the LLM to mask sensitive data, but this is not enforced at the platform level.

**Impact:** The LLM will likely comply with masking instructions in the PERSONA, but there is no guarantee — a malformed response could expose PII.

**Path forward:** Consider implementing a GUARDRAILS block with output checks for PII patterns, or add platform-level PII masking in the ABL runtime.

## 6. Workflow Tools

**Original:** Two Kore.ai WORKFLOW tools have no parameter schemas in the export:

- `UpdateTicketTest` — appears to be a test tool, not used in production flows
- `validateExpDental` — dental coverage eligibility check

**Current state:** `UpdateTicketTest` is omitted (test tool). `validateExpDental` is mapped to `validarElegibilidadTarea` MCP tool with `codigoTarea: "Transferencia_Dental"`.

**Impact:** None — both tools have production-equivalent implementations.

## 7. Voice-Specific Behavior

**Original:** Voice channel has specific behaviors: DTMF input handling, TTS responses, call transfer (SIP), Provider role on voice → immediate transfer to `Voz_Emergencias_y_Urgencias` queue, voice-specific menu substructure in Transfer_To_SAC.

**Current state:** Agents include voice-specific FLOW branches (e.g., Provider role handling in Broker_Entry_Gateway, voice menu in Transfer_To_SAC), but actual TTS, DTMF, and call transfer require the Voice channel adapter.

**Impact:** Voice-specific branches exist in agent logic but won't execute until the Voice adapter is connected.

**Path forward:** Implement Voice channel adapter with TTS/STT, DTMF, and SIP call transfer capabilities.

## 8. Content Variables

**Original:** Kore.ai has a global content variable `mcpServer` used as a tool prefix instruction: "All tool usage MUST explicitly start with the prefix Saludsa_MCP_Server."

**Current state:** In ABL, tool prefixes are handled by the tool registry configuration. Each tool file has `base_url` and individual tool names. No prefix convention is needed.

**Impact:** None — tool naming is handled by the registry.
```

- [ ] **Step 2: Format gaps document**

```bash
npx prettier --write examples/saludsa-production/docs/unimplemented-gaps.md
```

---

## Chunk 9: Validation & Commit

### Task 24: Validate project structure and compile check

- [ ] **Step 1: Verify all files exist**

```bash
find examples/saludsa-production -type f | sort
```

Expected: 47+ files (1 project.json, 2 config files, 17 agents, 12 tools, 17 locales, 1 README, 1 gaps doc).

- [ ] **Step 2: Verify project.json agent references match actual files**

```bash
for agent in samy_supervisor client_entry_gateway broker_entry_gateway transfer_services contract_data_assistant contract_sending pending_payments password_reset refund_guidance refund_status coverage_certificates other_services transfer_to_vitality transfer_to_sac pca_xpr_transfer fallback_handler farewell_handler; do
  if [ ! -f "examples/saludsa-production/agents/${agent}.agent.abl" ]; then
    echo "MISSING: agents/${agent}.agent.abl"
  fi
done
```

Expected: No "MISSING" output.

- [ ] **Step 3: Verify project.json tool references match actual files**

```bash
for tool in saludsa-identity saludsa-otp saludsa-services saludsa-coverage saludsa-transfer saludsa-zendesk saludsa-refund saludsa-misc code-identity code-otp code-transfer code-misc; do
  if [ ! -f "examples/saludsa-production/tools/${tool}.tools.abl" ]; then
    echo "MISSING: tools/${tool}.tools.abl"
  fi
done
```

Expected: No "MISSING" output.

- [ ] **Step 4: Run prettier on all files**

```bash
npx prettier --write "examples/saludsa-production/**/*"
```

- [ ] **Step 5: Verify ABL compiler can parse the project (if applicable)**

```bash
pnpm build --filter=@abl/compiler
# Then attempt to load the saludsa-production project
```

If the compiler has a validation command, run it against the project. If not, verify manually that each .agent.abl file follows the standard template from spec Section 8.0.

---

## Execution Order Summary

Tasks can be parallelized where noted:

| Task | Name                                               | Depends On | Can Parallelize With |
| ---- | -------------------------------------------------- | ---------- | -------------------- |
| 1    | Infrastructure (project.json, config, env, README) | None       | —                    |
| 2    | Identity + OTP tool registries                     | 1          | 3, 4                 |
| 3    | Service + Coverage tool registries                 | 1          | 2, 4                 |
| 4    | Transfer + Zendesk + Refund + Misc tool registries | 1          | 2, 3                 |
| 5    | Code tool registries (sandbox tools)               | 2, 3, 4    | —                    |
| 6    | Supervisor                                         | 1          | 5                    |
| 7    | Client Entry Gateway                               | 5, 6       | 8                    |
| 8    | Broker Entry Gateway                               | 5, 6       | 7                    |
| 9    | Contract Data Assistant                            | 5          | 10, 11, 12           |
| 10   | Contract Sending                                   | 5          | 9, 11, 12            |
| 11   | Pending Payments                                   | 5          | 9, 10, 12            |
| 12   | Password Reset                                     | 5          | 9, 10, 11            |
| 13   | Refund Guidance                                    | 5          | 14, 15               |
| 14   | Refund Status                                      | 5          | 13, 15               |
| 15   | Coverage Certificates                              | 5          | 13, 14               |
| 16   | Transfer Services (Dr. Salud)                      | 5          | 17, 18, 19, 20       |
| 17   | Other Services                                     | 5          | 16, 18, 19, 20       |
| 18   | Transfer To Vitality                               | 5          | 16, 17, 19, 20       |
| 19   | Transfer To SAC                                    | 5          | 16, 17, 18, 20       |
| 20   | PCA XPR Transfer                                   | 5          | 16, 17, 18, 19       |
| 21   | Fallback + Farewell                                | 5          | 16-20                |
| 22   | Locale files                                       | 7-21       | 23                   |
| 23   | Unimplemented gaps doc                             | All tasks  | 22                   |
| 24   | Validation & commit                                | All tasks  | —                    |
