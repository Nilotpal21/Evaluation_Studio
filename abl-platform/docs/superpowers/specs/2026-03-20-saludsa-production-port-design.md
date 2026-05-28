# Saludsa Production Port — Design Specification

**Date:** 2026-03-20
**Source:** Kore.ai Agent Platform export (`app-saludsa_app_temp-09-03-2026-18-07-43.json`)
**Target:** `examples/saludsa-production/` in ABL Platform
**Approach:** 1:1 port — 16 agents + supervisor, no consolidation, no mocks

---

## 1. Overview

Port the Saludsa "Samy" virtual health insurance assistant from Kore.ai Agent Platform to ABL Platform with full behavioral parity. The system handles identity validation, contract management, payments, refunds, coverage certificates, medical services (Dr. Salud), and human agent escalation across WhatsApp, Voice, Web, iOS, and Android channels.

**Language:** Ecuadorian Spanish (formal "usted" register)
**Business Hours:** Mon–Fri 8:30am–5:30pm America/Guayaquil
**Backend:** Saludsa MCP server at `${SALUDSA_MCP_ENDPOINT}`

### 1.1 Scope

**In scope:**

- All 16 specialist agents + 1 supervisor as ABL `.agent.abl` files
- All 30 MCP tool bindings with real endpoints (no mocks)
- All 15 code tools ported as sandbox tools or FLOW logic
- 3 events (End of Conversation, Agent Handoff, Welcome) mapped to ABL constructs
- 3 memory stores mapped to ABL session variables
- Full ESCALATE contracts targeting Kore.ai ContactCenter (adapter in-flight separately)
- Localization files (Spanish)
- `docs/unimplemented-gaps.md` documenting anything that can't be ported

**Out of scope (separate efforts):**

- Contact center adapter implementation (in-flight)
- Channel adapters (WhatsApp webhook, Voice/SIP, Web widget)
- Mock tool responses

### 1.2 Key Decisions

| Decision       | Choice                                     | Rationale                                             |
| -------------- | ------------------------------------------ | ----------------------------------------------------- |
| Directory      | `examples/saludsa-production/`             | Fresh directory, keep existing versions for reference |
| Agent count    | 16 + supervisor (1:1)                      | Behavioral parity, easy to validate per-agent         |
| Tool bindings  | Real MCP endpoints, no mocks               | Production-ready                                      |
| Business hours | Saludsa's `validateoutofhours` MCP tool    | Eliminates Kore.ai platform dependency                |
| Human handoff  | ESCALATE → Kore.ai ContactCenter           | CC adapter in-flight separately                       |
| Code tools     | Sandbox tools or FLOW logic                | Depends on complexity per tool                        |
| Unimplemented  | Documented in `docs/unimplemented-gaps.md` | Track all gaps for follow-up                          |

---

## 2. Project Structure

```
examples/saludsa-production/
├── project.json
├── config/
│   └── project-settings.json
├── environment/
│   └── env-vars.json
├── agents/
│   ├── samy_supervisor.agent.abl
│   ├── client_entry_gateway.agent.abl
│   ├── broker_entry_gateway.agent.abl
│   ├── transfer_services.agent.abl
│   ├── contract_data_assistant.agent.abl
│   ├── contract_sending.agent.abl
│   ├── pending_payments.agent.abl
│   ├── password_reset.agent.abl
│   ├── refund_guidance.agent.abl
│   ├── refund_status.agent.abl
│   ├── coverage_certificates.agent.abl
│   ├── other_services.agent.abl
│   ├── transfer_to_vitality.agent.abl
│   ├── transfer_to_sac.agent.abl
│   ├── pca_xpr_transfer.agent.abl
│   ├── fallback_handler.agent.abl
│   └── farewell_handler.agent.abl
├── tools/
│   ├── saludsa-identity.tools.abl
│   ├── saludsa-otp.tools.abl
│   ├── saludsa-services.tools.abl
│   ├── saludsa-coverage.tools.abl
│   ├── saludsa-transfer.tools.abl
│   ├── saludsa-zendesk.tools.abl
│   ├── saludsa-refund.tools.abl
│   ├── saludsa-misc.tools.abl
│   ├── code-identity.tools.abl
│   ├── code-otp.tools.abl
│   ├── code-transfer.tools.abl
│   └── code-misc.tools.abl
├── locales/
│   └── es/
│       ├── samy_supervisor.json
│       ├── client_entry_gateway.json
│       ├── broker_entry_gateway.json
│       ├── transfer_services.json
│       ├── contract_data_assistant.json
│       ├── contract_sending.json
│       ├── pending_payments.json
│       ├── password_reset.json
│       ├── refund_guidance.json
│       ├── refund_status.json
│       ├── coverage_certificates.json
│       ├── other_services.json
│       ├── transfer_to_vitality.json
│       ├── transfer_to_sac.json
│       ├── pca_xpr_transfer.json
│       ├── fallback_handler.json
│       └── farewell_handler.json
└── docs/
    └── unimplemented-gaps.md
```

---

## 3. Configuration Files

### 3.1 project.json

```json
{
  "format_version": "2.0",
  "name": "saludsa-production",
  "description": "Saludsa Samy — Production health insurance virtual assistant",
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

### 3.2 config/project-settings.json

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

### 3.3 environment/env-vars.json

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

---

## 4. MCP Tool Bindings (30 Tools)

All tools connect to the Saludsa backend via HTTP with Basic auth. The `sessionId` parameter is required on every tool and must be passed verbatim from the ABL session context.

### 4.1 Identity Tools (`tools/saludsa-identity.tools.abl`)

#### userValidation

Validates user type by phone number. Called by pre-processor logic to determine if caller is Cliente, Broker, Director, Business Representative, or non-client.

| Parameter     | Type   | Required | Default | Description                   |
| ------------- | ------ | -------- | ------- | ----------------------------- |
| telePhoneNum  | string | Yes      | —       | User's phone number           |
| inboundNumber | string | Yes      | —       | Inbound call/WhatsApp number  |
| channel       | string | Yes      | "voice" | Channel type                  |
| botUserId     | string | No       | —       | Platform user reference       |
| botSessionId  | string | No       | —       | Platform session reference    |
| sessionId     | string | Yes      | —       | Session identifier (verbatim) |

#### validate-user

Validates user by cédula/ID card number. Primary identity validation for clients.

| Parameter    | Type   | Required | Default | Description                   |
| ------------ | ------ | -------- | ------- | ----------------------------- |
| idCard       | string | Yes      | —       | Cédula or passport number     |
| channel      | string | No       | "web"   | Channel type                  |
| botUserId    | string | No       | —       | Platform user reference       |
| botSessionId | string | No       | —       | Platform session reference    |
| sessionId    | string | Yes      | —       | Session identifier (verbatim) |

#### validate-broker

Validates broker by ID card.

| Parameter   | Type   | Required | Default | Description                   |
| ----------- | ------ | -------- | ------- | ----------------------------- |
| idCard      | string | Yes      | —       | Broker's cédula               |
| channelType | string | Yes      | —       | Channel type                  |
| sessionId   | string | Yes      | —       | Session identifier (verbatim) |

#### validarAgenteVenta

Validates sales agent by director code or broker code.

| Parameter  | Type   | Required | Default | Description                   |
| ---------- | ------ | -------- | ------- | ----------------------------- |
| brokerCode | number | Yes      | —       | Broker/Director code          |
| sessionId  | string | Yes      | —       | Session identifier (verbatim) |

#### consultarAgenteVenta

Validates sales agent by national ID card.

| Parameter          | Type   | Required | Default | Description                         |
| ------------------ | ------ | -------- | ------- | ----------------------------------- |
| idCardOrPassport   | string | Yes      | —       | National ID or passport             |
| userRole           | string | Yes      | —       | Broker user role                    |
| userPhoneNumber    | string | Yes      | —       | Broker's phone number               |
| fromUserValidation | string | No       | —       | Flag if called from user validation |
| sessionId          | string | Yes      | —       | Session identifier (verbatim)       |

#### checkPriorityTransfer

Checks XPR/PCA/SAC priority transfer eligibility.

| Parameter | Type   | Required | Default | Description                   |
| --------- | ------ | -------- | ------- | ----------------------------- |
| idCard    | string | Yes      | —       | User's cédula                 |
| channel   | string | No       | "web"   | Channel type                  |
| sessionId | string | Yes      | —       | Session identifier (verbatim) |

#### getSecurityQuestions

Returns one random security question by user role (Holder, Beneficiary, Payer).

| Parameter | Type   | Required | Default | Description                   |
| --------- | ------ | -------- | ------- | ----------------------------- |
| sessionId | string | Yes      | —       | Session identifier (verbatim) |

### 4.2 OTP Tools (`tools/saludsa-otp.tools.abl`)

#### generate-otp

Generates OTP for phone verification. Backend fetches phone from Redis session.

| Parameter | Type   | Required | Default | Description                   |
| --------- | ------ | -------- | ------- | ----------------------------- |
| sessionId | string | Yes      | —       | Session identifier (verbatim) |

#### validate-otp

Validates OTP (broker flow).

| Parameter             | Type   | Required | Default | Description                   |
| --------------------- | ------ | -------- | ------- | ----------------------------- |
| userProvidedCodigoOtp | string | Yes      | —       | OTP entered by user           |
| sessionId             | string | Yes      | —       | Session identifier (verbatim) |

#### validate-otp-client

Validates OTP (client flow — for payments, password reset).

| Parameter         | Type   | Required | Default | Description                   |
| ----------------- | ------ | -------- | ------- | ----------------------------- |
| codigoOtpGenerado | string | Yes      | —       | OTP entered by user           |
| sessionId         | string | Yes      | —       | Session identifier (verbatim) |

#### pendingPaymentOtp

Validates phone number for OTP in payment flow.

| Parameter | Type   | Required | Default | Description                                                                        |
| --------- | ------ | -------- | ------- | ---------------------------------------------------------------------------------- |
| sessionId | string | Yes      | —       | Session identifier (marked optional in Kore.ai export but should always be passed) |
| userId    | string | No       | —       | User identifier                                                                    |

### 4.3 Service Tools (`tools/saludsa-services.tools.abl`)

#### contractStatus

Returns contract status details.

| Parameter       | Type    | Required | Default | Description                     |
| --------------- | ------- | -------- | ------- | ------------------------------- |
| channel         | string  | No       | —       | Channel type                    |
| isAuthQVerified | boolean | No       | —       | Security question verified flag |
| sessionId       | string  | Yes      | —       | Session identifier (verbatim)   |

#### sending-contracts

Retrieves and sends contract documents.

| Parameter       | Type    | Required | Default | Description                     |
| --------------- | ------- | -------- | ------- | ------------------------------- |
| channel         | string  | No       | —       | Channel type                    |
| contractId      | string  | No       | —       | Contract to send                |
| isAuthQVerified | boolean | No       | —       | Security question verified flag |
| inboundNumber   | string  | No       | —       | Inbound number                  |
| outboundNumber  | string  | No       | —       | Outbound number                 |
| sessionId       | string  | Yes      | —       | Session identifier (verbatim)   |

#### pending-payments

Returns pending payment amounts with classification.

| Parameter  | Type   | Required | Default | Description                   |
| ---------- | ------ | -------- | ------- | ----------------------------- |
| channel    | string | No       | —       | Channel type                  |
| contractId | string | No       | —       | Contract to check             |
| sessionId  | string | Yes      | —       | Session identifier (verbatim) |

#### passwordReset

Resets user password via email or SMS.

| Parameter         | Type   | Required | Default | Description                   |
| ----------------- | ------ | -------- | ------- | ----------------------------- |
| codigoTarea       | string | No       | —       | Task code                     |
| passwordResetType | string | No       | —       | Delivery: "Email" or "SMS"    |
| sessionId         | string | Yes      | —       | Session identifier (verbatim) |

#### steps-for-refund

Returns reimbursement steps and eligibility.

| Parameter | Type   | Required | Default | Description                   |
| --------- | ------ | -------- | ------- | ----------------------------- |
| channel   | string | No       | —       | Channel type                  |
| sessionId | string | Yes      | —       | Session identifier (verbatim) |

#### sendEmailTemplate

Sends templated email.

| Parameter   | Type   | Required | Default | Description                   |
| ----------- | ------ | -------- | ------- | ----------------------------- |
| useCaseName | string | Yes      | —       | Use case type                 |
| codigoTarea | string | No       | —       | Task code                     |
| sessionId   | string | Yes      | —       | Session identifier (verbatim) |

### 4.4 Coverage Tools (`tools/saludsa-coverage.tools.abl`)

#### checkCoverageEligibility

Checks coverage/travel certificate eligibility.

| Parameter       | Type   | Required | Default | Description                   |
| --------------- | ------ | -------- | ------- | ----------------------------- |
| codigoTarea     | string | No       | —       | Task code                     |
| certificateType | string | Yes      | —       | "Coverage" or "Travel"        |
| sessionId       | string | Yes      | —       | Session identifier (verbatim) |

#### getCoverageCertificate

Generates coverage or travel certificate.

| Parameter       | Type   | Required | Default | Description                                      |
| --------------- | ------ | -------- | ------- | ------------------------------------------------ |
| certificateType | string | Yes      | —       | "Coverage" or "Travel"                           |
| contractNumber  | string | No       | —       | Selected contract                                |
| beneficiaryName | string | No       | —       | Selected beneficiary                             |
| startDate       | string | No       | —       | YYYY-MM-DD (travel only)                         |
| endDate         | string | No       | —       | YYYY-MM-DD (travel only, max 61 days from start) |
| channel         | string | No       | —       | Channel type                                     |
| inboundNumber   | string | No       | —       | Inbound number                                   |
| outboundNumber  | string | No       | —       | Outbound number                                  |
| sessionId       | string | Yes      | —       | Session identifier (verbatim)                    |

### 4.5 Transfer Tools (`tools/saludsa-transfer.tools.abl`)

#### validateoutofhours

Validates after-hours service availability by queue. **Replaces Kore.ai platform API dependency.**

| Parameter   | Type   | Required | Default | Description                                                             |
| ----------- | ------ | -------- | ------- | ----------------------------------------------------------------------- |
| codigoTarea | string | Yes      | —       | Task/queue code (e.g., Autorizaciones, Urgencias, Transferencia_Travel) |
| sessionId   | string | Yes      | —       | Session identifier (verbatim)                                           |

#### validateTaskEligibility

Checks eligibility for business tasks and updates Zendesk.

| Parameter   | Type   | Required | Default | Description                                                                                                                                                |
| ----------- | ------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codigoTarea | string | Yes      | —       | Task code: MedicoEnLinea, Urgencias, Autorizaciones, MedicoDomicilio, Transferencia_Dental, TRANSFERENCIA_EXEQUIAL, TransferenciaPca, Transferencia_Travel |
| sessionId   | string | Yes      | —       | Session identifier (verbatim)                                                                                                                              |

#### validarElegibilidadTarea

Checks eligibility using business parameters.

| Parameter   | Type   | Required | Default | Description                   |
| ----------- | ------ | -------- | ------- | ----------------------------- |
| codigoTarea | string | Yes      | —       | Task code                     |
| sessionId   | string | Yes      | —       | Session identifier (verbatim) |

#### lpd-consent

Handles user data consent.

| Parameter   | Type   | Required | Default | Description                   |
| ----------- | ------ | -------- | ------- | ----------------------------- |
| userConsent | string | Yes      | —       | User consent value            |
| channel     | string | Yes      | —       | Channel type                  |
| sessionId   | string | Yes      | —       | Session identifier (verbatim) |

#### vitalityCheck

VPMS service check for Vitality program.

| Parameter | Type   | Required | Default | Description                   |
| --------- | ------ | -------- | ------- | ----------------------------- |
| sessionId | string | Yes      | —       | Session identifier (verbatim) |

### 4.6 Refund Tools (`tools/saludsa-refund.tools.abl`)

#### checkRefundStatus

Gets refund status by envelope number, amount, or date.

| Parameter      | Type   | Required | Default | Description                   |
| -------------- | ------ | -------- | ------- | ----------------------------- |
| channel        | string | No       | —       | Channel type                  |
| envelopeNumber | string | No       | —       | Envelope number (NA-xxxxxx)   |
| amount         | number | No       | —       | Refund amount                 |
| date           | string | No       | —       | YYYY-MM-DD                    |
| sessionId      | string | Yes      | —       | Session identifier (verbatim) |

#### resend-refund-settlement

Resends settlement for a settled refund.

| Parameter      | Type   | Required | Default | Description                   |
| -------------- | ------ | -------- | ------- | ----------------------------- |
| envelopeNumber | string | Yes      | —       | Envelope number (NA-xxxxxx)   |
| sessionId      | string | Yes      | —       | Session identifier (verbatim) |

#### prioritize-refund-zendesk

Marks delayed refund as priority in Zendesk.

| Parameter      | Type   | Required | Default | Description                   |
| -------------- | ------ | -------- | ------- | ----------------------------- |
| envelopeNumber | string | Yes      | —       | Envelope number (NA-xxxxxx)   |
| sessionId      | string | Yes      | —       | Session identifier (verbatim) |

### 4.7 Zendesk Tools (`tools/saludsa-zendesk.tools.abl`)

#### create-zendesk-ticket

| Parameter    | Type   | Required | Default        | Enum                                                                                                                    |
| ------------ | ------ | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| usecase      | string | No       | "new"          | new, transer_sac, transfer_sales, transfer_vitality, transfer_authorization, tranfer_emergency, transfer_online_medical |
| channel      | string | No       | "web"          | —                                                                                                                       |
| botSessionId | string | No       | —              | —                                                                                                                       |
| botUserId    | string | No       | —              | —                                                                                                                       |
| subject      | string | No       | "Nuevo Ticket" | —                                                                                                                       |
| comment      | string | No       | —              | —                                                                                                                       |
| tags         | string | No       | —              | —                                                                                                                       |
| note         | string | No       | —              | —                                                                                                                       |
| sessionId    | string | Yes      | —              | —                                                                                                                       |

#### update-zendesk-ticket

| Parameter           | Type    | Required | Default | Enum                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| usecase             | string  | Yes      | —       | user_details, lpd, refund, contract_status, transfer_sac, transfer_sales, transfer_vitality, transfer_authorization, transfer_emergency, transfer_online_medical, transfer_doctor_home, transfer_funeral, transfer_dental, transfer_travel, transfer_pca, refund_status, sending_contract, otp_code, password_reset, pending_payment_amounts, issuance_of_coverage, auth_fail, auth_fail_client, broker_client |
| channel             | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| transfer_type       | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| transfer_reason     | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| lpd_accept          | boolean | No       | true    | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| requerimientos_samy | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| region              | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| subject             | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| note                | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| publicNote          | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| status              | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| client_id           | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| client_name         | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| client_email        | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| client_phone        | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| requester_name      | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| requester_email     | string  | No       | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |
| new_ticket          | string  | No       | —       | create_vitality, create_authorization, create_emergency, create_online_medical_provider, create_online_medical_drsalud, create_doctor_home_provider, create_doctor_home_drsalud, ""                                                                                                                                                                                                                            |
| sessionId           | string  | Yes      | —       | —                                                                                                                                                                                                                                                                                                                                                                                                              |

#### close-zendesk-ticket

| Parameter      | Type   | Required | Default | Description                                                                          |
| -------------- | ------ | -------- | ------- | ------------------------------------------------------------------------------------ |
| closing_reason | string | No       | —       | self_service, abandonment, transfer_completed, after_hours, error, external_transfer |
| note           | string | No       | —       | Internal note before closing                                                         |
| tags           | string | No       | —       | Tags to add before closing                                                           |
| sessionId      | string | Yes      | —       | Session identifier (verbatim)                                                        |

---

## 5. Code Tools → ABL Implementation (15 Tools)

Each Kore.ai code tool is ported as either a **sandbox tool** (TYPE: sandbox, RUNTIME: javascript) or **FLOW logic** within the agent, depending on complexity.

### 5.1 Identity Code Tools (`tools/code-identity.tools.abl`)

#### ValidateUserID → Sandbox Tool

**Purpose:** Validates cédula/passport against backend, stores user details + priority flags in memory.

**Implementation:** Sandbox tool. Must call `POST /validateUser` and write results to session memory.

**Memory writes on success:** `userRole`, `contractNumber`, `ticketId`, `customerName`, `userId`, `needs_consent`, `apiError`, `channel`, `isXPRExist`, `isPCAExist`, `isDRSExist`, `isTRKExist`, `priorityTransfer` (or "NA"), `userValidation: true`, `otpValidated: false`, `authValidated: false`, `customerDetails`

**Memory writes on failure:** `errorMessage`, `invalidCount` (incremented), `apiError`

**Parameters:**

- `idCardOrPassport` (string) — cédula or passport number

#### BrokerIDValidator → Sandbox Tool

**Purpose:** Validates broker by national ID. Has role synonym mapping (Business Representative/Broker/Provider). Provider on voice → immediate transfer to `Voz_Emergencias_y_Urgencias` queue.

**Memory reads:** `sessionMeta`, `userInfo.idInvalidCountBR`, `userInfo.ticketId`, `userInfo.userType`
**Memory writes:** `userInfo.userRole`, `userInfo.apiError`, `userInfo.errorMessage`, `userInfo.idInvalidCountBR`, `transfer_metadata.*` (for Provider voice transfer)

**Parameters:**

- `idCardOrPassport` (string) — national ID or passport
- `userRole` (string) — Business Representative, Broker, or Provider
- `useCaseName` (string, optional)
- `ticketId` (number, optional)
- `channelType` (string, optional)
- `beneficiaryId` (string, optional)
- `whatsAppLinkNumber` (string, optional)

#### ClientIDValidator → Sandbox Tool

**Purpose:** Validates client ID in broker flow (Step 3). Sets `userValidation: true` ONLY on success. Tracks `idInvalidCountC` and `BRNotEligibleCount`.

**Memory writes on success:** `userValidation: true`, `customerDetails`, `isXPRExist`, `isPCAExist`, `isDRSExist`, `isTRKExist`, `priorityTransfer`, `customerName`, `clientName`

**Parameters:**

- `idCard` (string) — client's cédula

### 5.2 OTP Code Tools (`tools/code-otp.tools.abl`)

#### otpGenerator → Sandbox Tool

**Purpose:** Generates OTP by calling `POST /otpGenerator`. Backend sends OTP to registered phone.

**Parameters:** None (uses sessionId from context)

#### otpValidator → Sandbox Tool

**Purpose:** Validates user-entered OTP. Tracks `otpInvalidCount`. On success sets `otpValidated: true`. On 2nd failure updates Zendesk with `usecase: "auth_fail"`.

**Parameters:**

- `userProvidedCodigoOtp` (string) — OTP entered by user

#### OTPFailureSACTransferTool → Sandbox Tool

**Purpose:** Triggered on OTP failure after 2 attempts. Checks business hours via `validateoutofhours` MCP tool. If within hours: sets `handsOffStatus: true`, queue: "WhatsappSAC", reason: "El usuario no pudo realizar la autenticación OTP". If outside hours: sets `isOutsideBusinessHours: true`.

**Parameters:** None

### 5.3 Transfer Code Tools (`tools/code-transfer.tools.abl`)

#### saveTransferSAC → Sandbox Tool

**Purpose:** Saves SAC transfer metadata to session memory. Has non-trivial queue routing logic (mapping menu_number + channel → queueName/businessUnit), so implemented as sandbox tool rather than FLOW SET.

**Sets in session memory:** `queueName`, `businessUnit`, `handsOffStatus: true`, `reason`, `ticketId`, `externalPhoneNumber`, `sacMessage`

**Parameters:**

- `menu_number` (number, optional) — selected menu option
- `channel` (string, optional)
- `intent_identication` (boolean, optional)
- `sub_menu_number` (number, optional)
- `user_request` (string, optional)
- `sacReason` (string, optional)
- `ticketNumber` (number, optional)
- `message` (string, optional)
- `usecaseName` (string, optional)
- `region` (string, optional)

#### saveTransferSales → Sandbox Tool

**Purpose:** Saves sales transfer queue and business unit. Has queue computation based on role + channel.

**Parameters:**

- `role`, `channel`, `region`, `ticketNumber` (required), `userName`, `Id`, `email`, `phoneNumber`, `status`

#### saveTransferToVitality → Sandbox Tool

**Purpose:** Saves Vitality transfer metadata. Kept as sandbox for consistency with other transfer tools.

**Parameters:** None (reads from session context)

#### saveDrSaludMetaData → Sandbox Tool

**Purpose:** Saves Dr. Salud use case metadata with queue assignment logic based on useCaseName.

**Parameters:**

- `useCaseName` (string, required)
- `ticketId` (number, required)
- `channelType` (string, required)
- `beneficiaryId` (string, optional)
- `beneficiaryName` (string, optional)
- `whatsAppLinkNumber` (number, optional)

### 5.4 Miscellaneous Code Tools (`tools/code-misc.tools.abl`)

#### HandleServiceFailure → Sandbox Tool

**Purpose:** Global API failure handler. Triggered when any API returns `apiError: true`. Checks business hours, sets SAC transfer metadata with reason "Fallo de API".

**Parameters:** None

#### HandlePriorityProductTransfer → Sandbox Tool

**Purpose:** Routes priority products (XPR, PCA, SAC, FIDEVAL). Evaluates `priorityTransfer` flag and sets appropriate transfer metadata.

**Parameters:**

- `priorityTransfer` (string)

#### SendMessageWhatsapp → Documented Gap

**Purpose:** Calls Infobip API directly to send WhatsApp interactive button message for Doctor Home Visit. **Cannot be implemented as pure ABL** — requires WhatsApp channel adapter.

**Action:** Document in `unimplemented-gaps.md`. The FLOW step should RESPOND with the redirect message text; the actual WhatsApp interactive button delivery requires the channel adapter.

#### ValidacionFueradeHorario → Replaced by MCP Tool

**Purpose:** Originally called Kore.ai platform API for business hours. **Replaced by** `validateoutofhours` MCP tool. This code tool is not needed — agents call the MCP tool directly.

#### validateExpDental → Workflow Tool Reference

**Purpose:** Validates dental coverage eligibility. Defined as a WORKFLOW type in Kore.ai, not a code tool. Map to `validarElegibilidadTarea` MCP tool with `codigoTarea: "Transferencia_Dental"`.

---

## 6. Session Memory Design

All Kore.ai memory stores map to ABL `MEMORY: session` variables. ABL session memory is Redis-backed.

### 6.1 User Info (from `memory.userInfo`)

| ABL Variable               | Type    | Source                                 | Description                                                    |
| -------------------------- | ------- | -------------------------------------- | -------------------------------------------------------------- |
| `userType`                 | string  | Pre-processor / userValidation         | Cliente, Broker, Director, Business Representative, non client |
| `userRole`                 | string  | ValidateUserID / ClientIDValidator     | Holder, Beneficiary, Payer, Non Client                         |
| `userValidation`           | boolean | ValidateUserID / ClientIDValidator     | Primary validation flag — must be exactly `true`               |
| `contractNumber`           | string  | ValidateUserID                         | Contract ID                                                    |
| `ticketId`                 | string  | ValidateUserID / create-zendesk-ticket | Zendesk ticket ID                                              |
| `customerName`             | string  | ValidateUserID                         | Customer name                                                  |
| `userId`                   | string  | ValidateUserID                         | Cédula/passport used for validation                            |
| `customerDetails`          | object  | ValidateUserID                         | Full customer details object                                   |
| `priorityTransfer`         | string  | ValidateUserID                         | "XPR", "PCA", "SAC", or "NA"                                   |
| `isXPRExist`               | boolean | ValidateUserID                         | XPR product flag                                               |
| `isPCAExist`               | boolean | ValidateUserID                         | PCA product flag                                               |
| `isDRSExist`               | boolean | ValidateUserID                         | DRS product flag                                               |
| `isTRKExist`               | boolean | ValidateUserID                         | TRK product flag                                               |
| `invalidCount`             | number  | ValidateUserID                         | Client cédula retry counter (max 2)                            |
| `idInvalidCountBR`         | number  | BrokerIDValidator                      | Broker ID retry counter (max 2)                                |
| `idInvalidCountC`          | number  | ClientIDValidator                      | Client ID retry counter in broker flow (max 2)                 |
| `BRNotEligibleCount`       | number  | ClientIDValidator                      | Not-in-portfolio retry counter (max 2)                         |
| `otpInvalidCount`          | number  | otpValidator                           | OTP retry counter (max 2)                                      |
| `otpValidated`             | boolean | otpValidator                           | OTP validation flag                                            |
| `authValidated`            | boolean | getSecurityQuestions flow              | Security question auth flag                                    |
| `apiError`                 | boolean | Any API call                           | API error flag                                                 |
| `errorMessage`             | string  | Any API call                           | Error message text                                             |
| `needs_consent`            | boolean | ValidateUserID                         | Data consent required flag                                     |
| `closeConversation`        | string  | Pre-processor                          | "yes" to close session                                         |
| `closeConversationMessage` | string  | Pre-processor                          | Closure message                                                |
| `timeSlot`                 | string  | Pre-processor                          | Time-of-day greeting (Buenos días/tardes/noches)               |
| `title`                    | string  | Pre-processor                          | User title                                                     |
| `surName`                  | string  | Pre-processor                          | User surname                                                   |
| `channel`                  | string  | Channel adapter                        | whatsapp, voice, WEB, iOS, ANDROID                             |
| `beneficiaryId`            | string  | Dr. Salud flow                         | Selected beneficiary ID                                        |
| `beneficiaryName`          | string  | Dr. Salud flow                         | Selected beneficiary name                                      |

### 6.2 Transfer Metadata (from `memory.transfer_metadata`)

| ABL Variable             | Type    | Source                        | Description                      |
| ------------------------ | ------- | ----------------------------- | -------------------------------- |
| `queueName`              | string  | saveTransfer\* tools          | Contact center queue name        |
| `businessUnit`           | string  | saveTransfer\* tools          | Business unit for routing        |
| `externalPhoneNumber`    | string  | saveTransfer\* tools          | User's phone for callback        |
| `handsOffStatus`         | boolean | saveTransfer\* tools          | Human handoff trigger flag       |
| `reason`                 | string  | saveTransfer\* tools          | Transfer reason text             |
| `sacMessage`             | string  | saveTransferSAC               | Message for SAC agent            |
| `highPriorityTransfer`   | string  | HandlePriorityProductTransfer | Priority flag                    |
| `isOutsideBusinessHours` | boolean | OTPFailureSACTransferTool     | Outside hours flag               |
| `vitalityHours`          | boolean | saveTransferToVitality        | Vitality hours flag              |
| `whatsAppLinkNumber`     | string  | saveDrSaludMetaData           | WhatsApp link for Dr. Home Visit |
| `memberShipType`         | string  | Transfer flows                | Membership type                  |
| `userId`                 | string  | Transfer flows                | User ID for CC                   |
| `userEmail`              | string  | Transfer flows                | User email for CC                |
| `userPhoneNumber`        | string  | Transfer flows                | User phone for CC                |

### 6.3 Session Validation Context (from `memory.sessionValidationContext`)

| ABL Variable     | Type    | Description                        |
| ---------------- | ------- | ---------------------------------- |
| `isWhatsappFlag` | boolean | WhatsApp validation completed flag |

### 6.4 Session Metadata (from `memory.sessionMeta` — injected by channel adapter)

| ABL Variable                     | Source          | Description                          |
| -------------------------------- | --------------- | ------------------------------------ |
| `session.channel`                | Channel adapter | whatsapp, voice, WEB, iOS, ANDROID   |
| `session.phoneNumber`            | Channel adapter | User's phone number                  |
| `session.inboundNumber`          | Channel adapter | Inbound call/WhatsApp number         |
| `session.sessionId`              | ABL runtime     | Session identifier                   |
| `session.isFirstRequest`         | ABL runtime     | First interaction flag               |
| `session.identificacion_app_web` | Web/Mobile app  | Pre-authenticated user's cédula      |
| `session.nombre_titular`         | Web/Mobile app  | Holder name (from app)               |
| `session.priorityTransfer`       | Web/Mobile app  | Priority transfer from app deep-link |
| `session.targetAgent`            | Web/Mobile app  | Target agent for direct routing      |

---

## 7. Supervisor Agent Design

### 7.1 Samy_Supervisor

**File:** `agents/samy_supervisor.agent.abl`

**LLM Config:** model: gpt-4.1, temperature: 0.1, top_p: 0.7, max_tokens: 9999

**Core behavior:** Routes user messages to specialist agents. Never answers directly. Enforces 4-level priority cascade.

**PERSONA:**

> Eres Samy, el asistente virtual de Saludsa. Tu único rol es dirigir las solicitudes del usuario al agente especialista apropiado. Nunca respondes directamente con tu propio conocimiento. Toda comunicación con el usuario es en español ecuatoriano, registro formal ("usted").

**EXECUTION:**

```
model: gpt-4.1
temperature: 0.1
top_p: 0.7
max_tokens: 9999
max_iterations: 5
inline_gather: true
pipeline:
  enabled: true
  mode: sequential
  model: qwen35-a3b-35b
  shortCircuit:
    enabled: true
    confidenceThreshold: 0.85
```

**MEMORY:**

```
session:
  - userType
    TYPE: string
    DESCRIPTION: "User type from phone validation (Cliente, Broker, etc.)"
  - userValidation
    TYPE: boolean
    DESCRIPTION: "Primary validation flag — must be exactly true"
  - userRole
    TYPE: string
    DESCRIPTION: "Validated user role (Holder, Beneficiary, Payer, Non Client)"
  - channel
    TYPE: string
    DESCRIPTION: "Channel type (whatsapp, voice, WEB, iOS, ANDROID)"
  - priorityTransfer
    TYPE: string
    DESCRIPTION: "Priority product flag (XPR, PCA, SAC, or NA)"
  - handsOffStatus
    TYPE: boolean
    DESCRIPTION: "Human handoff trigger flag"
  - closeConversation
    TYPE: string
    DESCRIPTION: "Session termination flag (yes to close)"
  - isOutsideBusinessHours
    TYPE: boolean
    DESCRIPTION: "Outside business hours flag"
  - phoneNumber
    TYPE: string
    DESCRIPTION: "User phone number"
  - inboundNumber
    TYPE: string
    DESCRIPTION: "Inbound call/WhatsApp number"
  - ticketId
    TYPE: string
    DESCRIPTION: "Active Zendesk ticket ID"
```

**TEMPLATES:**

```
welcome:
  DEFAULT: "Hola, mi nombre es Samy; soy su asistente virtual de Saludsa. ¿En qué le puedo servir?"
  VOICE INSTRUCTIONS: "Greet warmly in Ecuadorian Spanish"

outside_business_hours:
  DEFAULT: "Nuestro horario de atención es de lunes a viernes de 8:30 a 17:30. Le invitamos a utilizar nuestra app o portal web para realizar sus gestiones."
```

**ON_START:**

```
RESPOND: TEMPLATE(welcome)
```

**HANDOFF rules (ordered, first-match-wins):**

```
# LEVEL 0 — Priority transfer override (highest priority)
# Source: effectivePriorityTransfer from userInfo (WA/Voice) or sessionMeta (Web/Mobile)
- TO: PCA_XPR_Transfer
  WHEN: priorityTransfer IN ["PCA", "XPR", "SAC"]
  CONTEXT:
    pass: [priorityTransfer, userRole, channel]
  RETURN: false

# LEVEL 1 — Validation enforcement (WhatsApp/Voice ONLY)
# FORBIDDEN for WEB/iOS/ANDROID
- TO: Client_Entry_Gateway
  WHEN: channel IN ["whatsapp", "voice"] AND userValidation != true AND userType != "Broker" AND userType != "Business Representative"
  CONTEXT:
    pass: [channel, userType, phoneNumber, inboundNumber]
  RETURN: true
  ON_RETURN: "validation_complete"

- TO: Broker_Entry_Gateway
  WHEN: channel IN ["whatsapp", "voice"] AND userValidation != true AND userType IN ["Broker", "Business Representative"]
  CONTEXT:
    pass: [channel, userType, phoneNumber]
  RETURN: true
  ON_RETURN: "validation_complete"

# LEVEL 2 — Agent Handoff Check
# Handled by ESCALATE triggers below (handsOffStatus == true → silent handoff to human)
# Not a HANDOFF rule — ESCALATE fires before HANDOFF evaluation

# LEVEL 3 — Intent-based routing (ONLY when userValidation == true OR channel is WEB/iOS/ANDROID)
- TO: Transfer_To_SAC
  WHEN: intent == "speak_to_agent"
  RETURN: false

- TO: Transfer_To_Vitality
  WHEN: intent == "vitality"
  RETURN: false

- TO: Transfer_Services
  WHEN: intent IN ["medical_authorization", "emergency", "telemedicine", "home_visit", "transfer_sales"]
  RETURN: false

- TO: Contract_Data_Assistant
  WHEN: intent == "contract_status"
  RETURN: true

- TO: Contract_Sending
  WHEN: intent == "contract_copy"
  RETURN: true

- TO: Pending_Payments
  WHEN: intent == "payment_inquiry"
  RETURN: true

- TO: Password_Reset
  WHEN: intent == "password_reset"
  RETURN: true

- TO: Refund_Guidance
  WHEN: intent == "refund_guidance"
  RETURN: true

- TO: Refund_Status
  WHEN: intent == "refund_status"
  RETURN: false

- TO: Coverage_Certificates
  WHEN: intent IN ["coverage_certificate", "travel_certificate"]
  RETURN: true

- TO: Other_Services
  WHEN: intent IN ["dental", "funeral", "travel_assistance"]
  RETURN: true

- TO: PCA_XPR_Transfer
  WHEN: intent IN ["pca_product", "xpr_product"]
  RETURN: false

- TO: Farewell_Handler
  WHEN: intent == "farewell" AND previous_system_message_was_offer == true
  RETURN: false

# LEVEL 4 — Fallback (must be last)
- TO: Fallback_Handler
  WHEN: true
  RETURN: true
```

**ESCALATE:**

```
triggers:
  - WHEN: handsOffStatus == true
    REASON: "Agent handoff flag set"
    PRIORITY: critical
    TAGS: [agent_handoff]
  - WHEN: routing_failures >= 3
    REASON: "Multiple routing failures"
    PRIORITY: high

context_for_human:
  - conversationSummary
  - conversationHistory
  - queueName
  - reason
  - ticketId
  - externalPhoneNumber
  - businessUnit
  - sacMessage
  - customerName
  - customerDetails
```

---

## 8. Agent Designs (All 16 Agents)

### 8.0 Standard ABL Agent Template

Every agent file MUST include these top-level keywords. This template shows the required structure:

```
AGENT: <Agent_Name>
VERSION: "1.0"
DESCRIPTION: "<one-line description>"

GOAL: |
  <multi-line goal statement>

PERSONA: |
  <agent personality and language instructions>

EXECUTION:
  model: gpt-4.1
  temperature: <per-agent value from Section 10>
  top_p: <per-agent value from Section 10>
  max_tokens: <per-agent value from Section 10>
  max_iterations: 15    # Higher for complex FLOW agents
  inline_gather: true

LIMITATIONS:
  - <guardrail 1>
  - <guardrail 2>

TOOLS:
  FROM "<tool_file>" USE: <tool1>, <tool2>

MEMORY:
  session:
    - <variable>
      TYPE: <type>
      DESCRIPTION: "<description>"

FLOW:
  entry_point: <first_step>
  steps:
    - <step1>
    - <step2>

  global_digressions:
    REASONING: false
    - INTENT: "hablar_con_agente"
      RESPOND: "Le transfiero con un agente."
      GOTO: escalate_to_human

  <step_name>:
    REASONING: false
    CALL: <tool_name>(<params>)
    ON_SUCCESS:
      - IF: <tool_name>.<field> == <value>
        SET: <variable> = <value>
        RESPOND: "<message>"
        THEN: <next_step>

CONSTRAINTS:
  <group_name>:
    - REQUIRE <condition>
      ON_FAIL: "<message>"

ESCALATE:
  triggers:
    - WHEN: <condition>
      REASON: "<reason>"
      PRIORITY: <level>

ON_ERROR:
  tool_error:
    RESPOND: "Lo sentimos, tenemos dificultades técnicas."
    RETRY: 1
    THEN: ESCALATE
  tool_timeout:
    RESPOND: "El servicio está tardando más de lo esperado."
    RETRY: 1
    THEN: ESCALATE

COMPLETE:
  - WHEN: <condition>
    RESPOND: "<message>"
```

**Key conventions (from reference examples):**

- Use `tool_name.field` (not `result.field`) to access tool return values
- Use YAML list syntax for `steps:` (not `[array]`)
- Specify `max_iterations: 15` for agents with 5+ FLOW steps, `max_iterations: 20` for Broker_Entry_Gateway (14 steps)
- Include `global_digressions` for "hablar con agente" in all FLOW-based agents
- All ON_ERROR blocks should call `HandleServiceFailure` → ESCALATE for API failures

### 8.1 Client_Entry_Gateway

**File:** `agents/client_entry_gateway.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.5, max_tokens: 10000

**Purpose:** Identity validation for Holders, Beneficiaries, Payers, Non-Clients on WhatsApp/Voice.

**TOOLS:**

- `FROM "./tools/code-identity.tools.abl" USE: ValidateUserID`
- `FROM "./tools/code-misc.tools.abl" USE: HandleServiceFailure`
- `FROM "./tools/saludsa-identity.tools.abl" USE: userValidation`

**MEMORY session variables:** `userType`, `userRole`, `invalidCount`, `userValidation`, `priorityTransfer`, `errorMessage`, `customerDetails`, `contractNumber`, `ticketId`, `timeSlot`, `title`, `surName`

**PERSONA:**

> Agente de validación de identidad de Saludsa. Saluda y valida la identidad del usuario mediante cédula o pasaporte. No menciona roles ni validaciones al usuario. Español formal.

**FLOW:**

```
entry_point: pre_check
steps: [pre_check, greet_and_ask_cedula, validate_id, check_priority, validation_success, non_client_offer, session_closed]

pre_check:
  REASONING: false
  # Pre-processor equivalent: call userValidation with phone number
  CALL: userValidation(telePhoneNum: session.phoneNumber, inboundNumber: session.inboundNumber, channel: session.channel, sessionId: session.sessionId)
  ON_SUCCESS:
    - IF: userValidation.userType IN ["Broker", "Director", "Business Representative"]
      RESPOND: "Este número está asociado a un perfil de Broker. Por favor utilice el número de WhatsApp correspondiente."
      SET: closeConversation = "yes"
      THEN: COMPLETE
    - ELSE:
      SET: userType = userValidation.userType
      SET: timeSlot = result.timeSlot
      SET: title = result.title
      SET: surName = result.surName
      THEN: greet_and_ask_cedula

greet_and_ask_cedula:
  REASONING: false
  RESPOND: "Hola, soy Samy, su asistente virtual de Saludsa.\n¿Me puede proporcionar su cédula o pasaporte?\nLa conversación se almacenará y monitoreará por seguridad."
  GATHER:
    - cedula
      TYPE: string
      ASK: ""
      VALIDATE: length >= 6
  THEN: validate_id

validate_id:
  REASONING: false
  CALL: ValidateUserID(idCardOrPassport: cedula)
  ON_SUCCESS:
    - IF: ValidateUserID.userDetails.userValidation == true
      SET: userValidation = true
      SET: userRole = ValidateUserID.userDetails.userRole
      SET: priorityTransfer = ValidateUserID.userDetails.priorityTransfer
      SET: contractNumber = ValidateUserID.userDetails.contractNumber
      SET: customerDetails = ValidateUserID.userDetails.customerDetails
      THEN: check_priority
    - ELSE IF: ValidateUserID.userDetails.apiError == true
      CALL: HandleServiceFailure()
      THEN: ESCALATE
    - ELSE:
      SET: invalidCount = ValidateUserID.userDetails.invalidCount
      - IF: invalidCount >= 2
        THEN: session_closed
      - ELSE:
        RESPOND: "Proporcione el número de identificación válido / número de pasaporte"
        GATHER:
          - cedula
            TYPE: string
            ASK: ""
        THEN: validate_id

check_priority:
  REASONING: false
  - IF: priorityTransfer IN ["XPR", "PCA", "SAC"]
    THEN: COMPLETE  # Supervisor routes to PCA_XPR_Transfer
  - ELSE IF: userRole == "Non Client"
    THEN: non_client_offer
  - ELSE:
    THEN: validation_success

validation_success:
  REASONING: false
  RESPOND: "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?"
  THEN: COMPLETE

non_client_offer:
  REASONING: false
  RESPOND: "¿Quieres comprar un plan?"
  THEN: COMPLETE

session_closed:
  REASONING: false
  RESPOND: "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante."
  SET: closeConversation = "yes"
  THEN: COMPLETE
```

**COMPLETE:**

```
- WHEN: userValidation == true
  RESPOND: ""
- WHEN: closeConversation == "yes"
  RESPOND: ""
```

### 8.2 Broker_Entry_Gateway

**File:** `agents/broker_entry_gateway.agent.abl`
**LLM:** temperature: 0.1, top_p: 0.5, max_tokens: 10000

**Purpose:** 3-step validation chain for Brokers/Business Representatives: Broker ID → OTP → Client ID.

**TOOLS:**

- `FROM "./tools/code-identity.tools.abl" USE: BrokerIDValidator, ClientIDValidator`
- `FROM "./tools/code-otp.tools.abl" USE: otpGenerator, otpValidator, OTPFailureSACTransferTool`
- `FROM "./tools/code-misc.tools.abl" USE: HandleServiceFailure`
- `FROM "./tools/saludsa-identity.tools.abl" USE: userValidation`

**MEMORY session variables:** `userType`, `userRole`, `userValidation`, `idInvalidCountBR`, `otpInvalidCount`, `idInvalidCountC`, `BRNotEligibleCount`, `priorityTransfer`, `timeSlot`, `title`, `surName`

**PERSONA:**

> Agente de validación de identidad para Representantes de Negocio y Brokers de Saludsa. Gestiona la validación en tres pasos: identificación del broker, verificación OTP, y validación del cliente. No menciona roles ni validaciones internas. Español formal.

**FLOW:**

```
entry_point: pre_check
steps: [pre_check, role_identification, ask_broker_id, validate_broker_id, generate_otp, ask_otp, validate_otp, ask_client_id, validate_client_id, check_client_priority, validation_success, broker_session_closed, client_session_closed, portfolio_closed]

pre_check:
  REASONING: false
  CALL: userValidation(telePhoneNum: session.phoneNumber, inboundNumber: session.inboundNumber, channel: session.channel, sessionId: session.sessionId)
  ON_SUCCESS:
    SET: userType = userValidation.userType
    SET: timeSlot = result.timeSlot
    SET: title = result.title
    SET: surName = result.surName
    - IF: userType IN ["Broker", "Business Representative"]
      THEN: ask_broker_id
    - ELSE:
      THEN: role_identification

role_identification:
  REASONING: false
  RESPOND: "{timeSlot}! Para continuar, por favor confirme su rol seleccionando una de las siguientes opciones:\n1. Representante de Negocios (RN)\n2. Broker"
  GATHER:
    - selectedRole
      TYPE: string
      ASK: ""
  SET: userRole = selectedRole  # Map 1→Business Representative, 2→Broker
  THEN: ask_broker_id

ask_broker_id:
  REASONING: false
  RESPOND: "Hola, {title}. {surName}, me puede proporcionar su cedula / pasaporte? La conversación se almacenará y monitoreará por seguridad."
  GATHER:
    - brokerCedula
      TYPE: string
      ASK: ""
      VALIDATE: length >= 6
  THEN: validate_broker_id

validate_broker_id:
  REASONING: false
  CALL: BrokerIDValidator(idCardOrPassport: brokerCedula, userRole: userRole)
  ON_SUCCESS:
    - IF: BrokerIDValidator.success == true
      THEN: generate_otp
    - ELSE IF: BrokerIDValidator.apiError == true
      CALL: HandleServiceFailure()
      THEN: ESCALATE
    - ELSE:
      SET: idInvalidCountBR = BrokerIDValidator.idInvalidCountBR
      - IF: idInvalidCountBR >= 2
        THEN: broker_session_closed
      - ELSE:
        RESPOND: "Proporcione un número de identificación de corredor/pasaporte válido"
        GATHER:
          - brokerCedula
            TYPE: string
            ASK: ""
        THEN: validate_broker_id

generate_otp:
  REASONING: false
  CALL: otpGenerator()
  ON_SUCCESS:
    THEN: ask_otp
  ON_FAIL:
    CALL: HandleServiceFailure()
    THEN: ESCALATE

ask_otp:
  REASONING: false
  RESPOND: "Hemos enviado un código OTP a su número registrado. Por favor, ingrese el código."
  GATHER:
    - otpCode
      TYPE: string
      ASK: ""
  THEN: validate_otp

validate_otp:
  REASONING: false
  CALL: otpValidator(userProvidedCodigoOtp: otpCode)
  ON_SUCCESS:
    - IF: otpValidator.otpValidated == true
      THEN: ask_client_id
    - ELSE:
      SET: otpInvalidCount = otpValidator.otpInvalidCount
      - IF: otpInvalidCount >= 2
        CALL: OTPFailureSACTransferTool()
        THEN: ESCALATE  # Transfer to SAC, NOT session close
      - ELSE:
        RESPOND: "El código OTP no es válido. Por favor, intente nuevamente."
        GATHER:
          - otpCode
            TYPE: string
            ASK: ""
        THEN: validate_otp

ask_client_id:
  REASONING: false
  RESPOND: "Por favor, indíqueme la identificación o número de contrato de su cliente para quien desea realizar la gestión, para continuar de manera segura con el servicio."
  GATHER:
    - clientCedula
      TYPE: string
      ASK: ""
  THEN: validate_client_id

validate_client_id:
  REASONING: false
  CALL: ClientIDValidator(idCard: clientCedula)
  ON_SUCCESS:
    - IF: ClientIDValidator.userValidation == true
      SET: userValidation = true
      SET: priorityTransfer = ClientIDValidator.priorityTransfer
      SET: customerDetails = ClientIDValidator.customerDetails
      THEN: check_client_priority
    - ELSE IF: ClientIDValidator.BRNotEligibleCount > 0
      SET: BRNotEligibleCount = ClientIDValidator.BRNotEligibleCount
      - IF: BRNotEligibleCount >= 2
        THEN: portfolio_closed
      - ELSE:
        RESPOND: "La identificación ingresada no corresponde a su cartera de clientes. Por favor, intente nuevamente."
        GATHER:
          - clientCedula
            TYPE: string
            ASK: ""
        THEN: validate_client_id
    - ELSE:
      SET: idInvalidCountC = ClientIDValidator.idInvalidCountC
      - IF: idInvalidCountC >= 2
        THEN: client_session_closed
      - ELSE:
        RESPOND: "Proporcione un número de identificación de cliente/pasaporte válido"
        GATHER:
          - clientCedula
            TYPE: string
            ASK: ""
        THEN: validate_client_id

check_client_priority:
  REASONING: false
  - IF: priorityTransfer IN ["XPR", "PCA", "SAC"]
    THEN: COMPLETE  # Supervisor routes to PCA_XPR_Transfer
  - ELSE:
    THEN: validation_success

validation_success:
  REASONING: false
  RESPOND: "Gracias, su identidad ha sido validada. ¿En qué le puedo servir?"
  THEN: COMPLETE

broker_session_closed:
  REASONING: false
  RESPOND: "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante."
  SET: closeConversation = "yes"
  THEN: COMPLETE

client_session_closed:
  REASONING: false
  RESPOND: "Para cuidar su seguridad y su información, hemos cerrado esta sesión luego de varios intentos fallidos. Puede volver a intentarlo más adelante."
  SET: closeConversation = "yes"
  THEN: COMPLETE

portfolio_closed:
  REASONING: false
  RESPOND: "Lamentablemente, la identificación ingresada no corresponde a su cartera de clientes y se ha superado el número máximo de intentos permitidos. Para cuidar la seguridad de la información, esta conversación se ha cerrado de forma automática. Por favor, inténtelo nuevamente más tarde"
  SET: closeConversation = "yes"
  THEN: COMPLETE
```

**CONSTRAINTS:**

```
always:
  - REQUIRE userValidation != true IMPLIES intent_routing_disabled
    ON_FAIL: "Intent routing is disabled until full 3-step validation completes"
```

### 8.3 Contract_Data_Assistant

**File:** `agents/contract_data_assistant.agent.abl`
**LLM:** temperature: 0.1, top_p: 0.5, max_tokens: 10000

**Purpose:** Retrieves plan details and contract status after security question auth on WhatsApp/Voice.

**TOOLS:**

- `FROM "./tools/saludsa-identity.tools.abl" USE: getSecurityQuestions`
- `FROM "./tools/saludsa-services.tools.abl" USE: contractStatus`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`
- `FROM "./tools/code-misc.tools.abl" USE: HandleServiceFailure`

**FLOW:**

```
entry_point: check_role_and_channel
steps: [check_role_and_channel, security_question_auth, retrieve_contracts, display_contracts, not_eligible]

check_role_and_channel:
  REASONING: false
  - IF: session.userRole IN ["Non Client", "Payer"]
    THEN: not_eligible
  - ELSE IF: session.channel IN ["WEB", "iOS", "ANDROID"]
    THEN: retrieve_contracts  # Skip security questions for digital channels
  - ELSE:
    THEN: security_question_auth

security_question_auth:
  REASONING: false
  RESPOND: "Antes de continuar, necesito hacerle una pregunta de validación para proteger su información."
  CALL: getSecurityQuestions(sessionId: session.sessionId)
  ON_SUCCESS:
    - IF: getSecurityQuestions.isOtpVerified == true OR getSecurityQuestions.isAuthQVerified == true
      THEN: retrieve_contracts  # Already authenticated
    - ELSE:
      RESPOND: getSecurityQuestions.question
      GATHER:
        - securityAnswer
          TYPE: string
          ASK: ""
      # Validate answer (2 attempts)
      # On success: SET authValidated = true, THEN: retrieve_contracts
      # On failure attempt 1: re-trigger getSecurityQuestions
      # On failure attempt 2: update-zendesk-ticket, ESCALATE

retrieve_contracts:
  REASONING: false
  CALL: contractStatus(channel: session.channel, isAuthQVerified: authValidated, sessionId: session.sessionId)
  ON_SUCCESS:
    THEN: display_contracts
  ON_FAIL:
    CALL: HandleServiceFailure()
    THEN: ESCALATE

display_contracts:
  REASONING: true  # LLM formats contract data for display
  # Present max 5 contracts, prioritized: Active → Pending → Cancelled
  # Status categories: Activo, Pendiente, Cancelado, Donado, Desgravamen
  RESPOND: "formatted contract summary"
  CALL: update-zendesk-ticket(usecase: "contract_status", channel: session.channel, sessionId: session.sessionId)
  THEN: COMPLETE

not_eligible:
  REASONING: false
  RESPOND: "En este momento, su perfil no tiene acceso a este tipo de información o servicio. ¿Le puedo servir en algo adicional?"
  THEN: COMPLETE
```

**LIMITATIONS:**

- Cannot display more than 5 contracts
- Must prioritize Active contracts first
- Must not ask user for channel or role — read from session
- Must maintain conversation in Spanish only
- Must not mention Zendesk tickets to user

### 8.4 Contract_Sending

**File:** `agents/contract_sending.agent.abl`
**LLM:** temperature: 0.2, top_p: 0.5, max_tokens: 10000

**Purpose:** Sends contract document copies after security question auth.

**TOOLS:**

- `FROM "./tools/saludsa-identity.tools.abl" USE: getSecurityQuestions`
- `FROM "./tools/saludsa-services.tools.abl" USE: sending-contracts`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`

**FLOW:** Similar to Contract_Data_Assistant:

1. Check role (Payer/Non-Client → not eligible)
2. Check channel (WEB/iOS/ANDROID → skip auth; Broker/BR on WhatsApp → skip auth)
3. Security question auth (WhatsApp/Voice, Holder/Beneficiary)
4. Call `sending-contracts` with contract selection
5. Deliver via email or chat attachment
6. Update Zendesk ticket

**CONSTRAINTS:**

```
always:
  - REQUIRE NOT (userRole IN ["Payer", "Non Client"])
    ON_FAIL: "Cannot receive or view contracts"
```

### 8.5 Pending_Payments

**File:** `agents/pending_payments.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.5, max_tokens: 10000

**Purpose:** Payment/billing inquiries with OTP auth.

**TOOLS:**

> Note: Code tools (`otpGenerator`, `otpValidator`) internally call MCP tools (`generate-otp`, `validate-otp-client`). Only code tools are listed in the agent's TOOLS section. MCP tools are called indirectly through the code tools.

- `FROM "./tools/code-otp.tools.abl" USE: otpGenerator, otpValidator, OTPFailureSACTransferTool`
- `FROM "./tools/saludsa-otp.tools.abl" USE: pendingPaymentOtp`
- `FROM "./tools/saludsa-services.tools.abl" USE: pending-payments`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`
- `FROM "./tools/code-misc.tools.abl" USE: HandleServiceFailure`

**FLOW:**

```
entry_point: check_channel
steps:
  - check_channel
  - otp_phone_validation
  - otp_generate
  - otp_gather
  - otp_validate
  - retrieve_payments
  - display_payments
  - closing_question

check_channel:
  REASONING: false
  - IF: session.channel IN ["WEB", "iOS", "ANDROID"]
    THEN: retrieve_payments  # Skip OTP for digital channels
  - ELSE:
    THEN: otp_phone_validation

otp_phone_validation:
  REASONING: false
  CALL: pendingPaymentOtp(sessionId: session.sessionId, userId: session.userId)
  ON_SUCCESS:
    THEN: otp_generate
  ON_FAIL:
    CALL: HandleServiceFailure()
    THEN: ESCALATE

otp_generate:
  REASONING: false
  CALL: otpGenerator()
  ON_SUCCESS:
    RESPOND: "Hemos enviado un código OTP a su número registrado. Por favor, ingrese el código."
    THEN: otp_gather
  ON_FAIL:
    CALL: HandleServiceFailure()
    THEN: ESCALATE

otp_gather:
  REASONING: false
  GATHER:
    - otpCode
      TYPE: string
      ASK: ""
  THEN: otp_validate

otp_validate:
  REASONING: false
  CALL: otpValidator(userProvidedCodigoOtp: otpCode)
  ON_SUCCESS:
    - IF: otpValidator.otpValidated == true
      THEN: retrieve_payments
    - ELSE:
      SET: otpInvalidCount = otpValidator.otpInvalidCount
      - IF: otpInvalidCount >= 2
        CALL: OTPFailureSACTransferTool()
        THEN: ESCALATE
      - ELSE:
        RESPOND: "El código OTP no es válido. Por favor, intente nuevamente."
        THEN: otp_gather

retrieve_payments:
  REASONING: false
  CALL: pending-payments(channel: session.channel, sessionId: session.sessionId)
  ON_SUCCESS:
    THEN: display_payments
  ON_FAIL:
    CALL: HandleServiceFailure()
    THEN: ESCALATE

display_payments:
  REASONING: true  # LLM formats payment data based on category
  # Categories: all-clear, single-pending, single-in-process,
  #             multiple-pending, multiple-in-process, mixed
  # Format plan names: add space after colon if missing (e.g., ":3" → ": 3")
  CALL: update-zendesk-ticket(usecase: "pending_payment_amounts", channel: session.channel, sessionId: session.sessionId)
  THEN: closing_question

closing_question:
  REASONING: false
  RESPOND: "¿Le puedo servir en algo más?"
  THEN: COMPLETE
```

**global_digressions:**

```
- INTENT: "hablar_con_agente"
  RESPOND: "Le transfiero con un agente."
  GOTO: escalate_to_human
```

### 8.6 Password_Reset

**File:** `agents/password_reset.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.5, max_tokens: 10000

**Purpose:** Password reset with role eligibility checks and OTP.

**FLOW:**

1. Check role:
   - Holder → proceed
   - Beneficiary → "Contacte al titular de la cuenta"
   - Payer → "El restablecimiento no aplica" → end
   - Non Client → "El restablecimiento no aplica" → redirect to onboarding
   - Broker/BR → can initiate for client
2. OTP auth (WhatsApp/Voice only)
3. Ask delivery preference: email or SMS
4. Call `passwordReset`
5. Mask email/phone in response
6. Update Zendesk

**TOOLS:**

- `FROM "./tools/saludsa-otp.tools.abl" USE: validate-otp-client`
- `FROM "./tools/saludsa-services.tools.abl" USE: passwordReset`
- `FROM "./tools/code-otp.tools.abl" USE: otpGenerator, otpValidator`

### 8.7 Refund_Guidance

**File:** `agents/refund_guidance.agent.abl`
**LLM:** temperature: 0.1, top_p: 0.5, max_tokens: 10000

**Purpose:** Step-by-step medical expense reimbursement guidance.

**FLOW:**

1. Check role (Payer/Non-Client → not eligible message)
2. Call `steps-for-refund` to get eligible contracts
3. If single contract → proceed; if multiple → let user select
4. Ask: step-by-step or summary?
5. Display reimbursement steps by category (lab, medications, therapies, procedures, consultations, hospital)
6. Include tutorial video links
7. Update Zendesk throughout

**PERSONA:**

> Agente de Guía de Reembolsos de Saludsa. Guía al usuario paso a paso en el proceso de reembolso de gastos médicos, adaptándose a su rol, elegibilidad y canal.

**LIMITATIONS:**

- Must not skip steps or change order
- Must not add information from own knowledge
- Must display instructions one at a time (conversational), not all at once
- Must not mention Zendesk tickets to user
- Must include URLs/links/tutorials even in summary mode

### 8.8 Refund_Status

**File:** `agents/refund_status.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.6, max_tokens: 10000

**Purpose:** Simple transfer agent — immediately transfers refund status inquiries to a human SAC agent. Does NOT perform any lookup itself.

> **Note:** The Kore.ai source system defines this as a passthrough agent that calls `saveTransferSAC` and triggers Agent Handoff. It does not use `checkRefundStatus`, `resend-refund-settlement`, or `prioritize-refund-zendesk`. Those tools exist in the MCP server but are not bound to this agent in the source.

**TOOLS:**

- `FROM "./tools/code-transfer.tools.abl" USE: saveTransferSAC`

**FLOW:**

```
entry_point: transfer
steps: [transfer]

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

### 8.9 Coverage_Certificates

**File:** `agents/coverage_certificates.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.5, max_tokens: 10000

**Purpose:** Generate coverage and travel certificates. Most complex agent.

**TOOLS:**

- `FROM "./tools/saludsa-identity.tools.abl" USE: getSecurityQuestions`
- `FROM "./tools/saludsa-coverage.tools.abl" USE: checkCoverageEligibility, getCoverageCertificate`
- `FROM "./tools/saludsa-services.tools.abl" USE: sendEmailTemplate`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`

**FLOW:**

1. Security question auth (WhatsApp/Voice, Holder/Beneficiary only)
2. Identify certificate type (Coverage vs Travel) — ask if ambiguous
3. Call `checkCoverageEligibility`
4. If eligible contracts: present list, let user select
5. If multiple beneficiaries on selected contract: present list
6. For Travel: gather start date and end date (max 61 days, current year default)
7. Call `getCoverageCertificate`
8. Deliver certificate (email via `sendEmailTemplate` or inline)
9. Update Zendesk throughout

**CONSTRAINTS:**

```
pre_certificate:
  - REQUIRE travel_end_date - travel_start_date <= 61
    ON_FAIL: "El certificado de viaje no puede exceder 61 días desde la fecha de inicio."
  - REQUIRE NOT (userRole IN ["Payer", "Non Client"])
    ON_FAIL: "Coverage certificate does not apply for this profile."
```

**Special rules:**

- "wife"/"husband" → match "spouse" as `RelacionDependiente`
- "1", "1st", "first" → select first item from displayed list
- Dates without year → assign current calendar year
- If `success: false` from any tool → call `saveTransferSAC` → ESCALATE

### 8.10 Transfer_Services (Dr. Salud)

**File:** `agents/transfer_services.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.5, max_tokens: 10000

**Purpose:** Handles 5 medical service use cases under Dr. Salud.

**Use cases (each has its own FLOW branch):**

| Use Case                  | Code            | Flow                                       |
| ------------------------- | --------------- | ------------------------------------------ |
| DRSALUDAUTORIZATION       | Autorizaciones  | Eligibility → Zendesk ticket → SAC handoff |
| DRSALUDEMERGENCY          | Urgencias       | Eligibility → Zendesk ticket → SAC handoff |
| ONLINEMEDICALCONSULTATION | MedicoEnLinea   | Eligibility → redirect to telemedicine     |
| DOCTORHOMEVISIT           | MedicoDomicilio | Eligibility → WhatsApp redirect            |
| TRANSFERTOSALES           | N/A             | Direct transfer to sales queue             |

**TOOLS:**

- `FROM "./tools/saludsa-transfer.tools.abl" USE: validateTaskEligibility, validateoutofhours`
- `FROM "./tools/saludsa-services.tools.abl" USE: sendEmailTemplate`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`
- `FROM "./tools/code-transfer.tools.abl" USE: saveDrSaludMetaData, saveTransferSales`

**FLOW:** Entry point identifies use case, then branches to use-case-specific steps. Each use case has independent step numbering.

**CONSTRAINTS:**

```
always:
  - REQUIRE useCaseName is determined before any tool call
    ON_FAIL: "Must identify use case before executing tools"
  - REQUIRE Spanish-only communication
    ON_FAIL: "All communication must be in Spanish"
```

### 8.11 Other_Services

**File:** `agents/other_services.agent.abl`
**LLM:** temperature: 0.3, top_p: 0.5, max_tokens: 10000

**Purpose:** Dental coverage, funeral services, travel assistance.

**Three independent use cases:**

| Use Case                   | Partner                  | Contact Info                               |
| -------------------------- | ------------------------ | ------------------------------------------ |
| DENTAL_COVERAGE            | Confident                | Phone: 0985387985, WhatsApp: +593985387985 |
| FUNERAL_SERVICE            | Grupo Jardines del Valle | Phone: (02) 2550290                        |
| TRANSFER_TO_SALUDSA_TRAVEL | Assist Card              | WhatsApp: +54 9 11 2703-9665               |

**TOOLS:**

- `FROM "./tools/saludsa-transfer.tools.abl" USE: validarElegibilidadTarea, validateTaskEligibility`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`

**Special rules:**

- Dental: Payer/Non-Client → "Este beneficio no está disponible para su perfil"
- Each use case has independent STEP sequence
- Variables from one use case must NOT be reused in another

### 8.12 Transfer_To_Vitality

**File:** `agents/transfer_to_vitality.agent.abl`
**LLM:** temperature: 0.3, top_p: 1, max_tokens: 10000

**Purpose:** Transfer Vitality wellness program inquiries.

**FLOW:**

1. Call `saveTransferToVitality` (sets transfer metadata)
2. Check business hours via `validateoutofhours`
3. If within hours → set `handsOffStatus: true` → ESCALATE (Agent Handoff)
4. If outside hours → display outside-hours message, offer alternative assistance
5. If `handsOffStatus` already true → do NOT generate any user message, trigger handoff silently

### 8.13 Transfer_To_SAC

**File:** `agents/transfer_to_sac.agent.abl`
**LLM:** temperature: 0, top_p: 0.6, max_tokens: 10000

**Purpose:** Customer service escalation with intent matching and menu.

**FLOW:**

1. If `handsOffStatus` already true → silent handoff (no user message)
2. Ask user's reason for wanting to speak with an agent
3. Match against predefined intent list (transaction status, complaints, coverage info, contract updates, cancellations, reactivation, etc.)
4. If intent matches → transfer immediately with appropriate metadata
5. If no match (attempt 1) → ask again
6. If no match (attempt 2) → present 4-option menu:
   - 1. Dr. Salud
   - 2. Servicio al Cliente (SAC)
   - 3. Vitality
   - 4. Ventas
7. Voice channel has different menu structure with submenus
8. Check business hours before transfer
9. Outside hours → display hours message

**TOOLS:**

- `FROM "./tools/code-transfer.tools.abl" USE: saveTransferSAC, saveTransferSales, saveTransferToVitality, saveDrSaludMetaData`
- `FROM "./tools/saludsa-transfer.tools.abl" USE: validateoutofhours`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: update-zendesk-ticket`

### 8.14 PCA_XPR_Transfer

**File:** `agents/pca_xpr_transfer.agent.abl`
**LLM:** temperature: 0.1, top_p: 0.5, max_tokens: 10000

**Purpose:** Priority product routing (XPR, PCA, JAPI, Hunter, Fideval, TRK/TRANKI).

**Behavior per product:**

- **XPR (Experience):** Voice → direct call transfer; Digital → provide contact info
- **PCA/ServiAlamo:** Transfer to SAC with PCA queue
- **Fideval:** Phone: 1-800-022945301, WhatsApp: +593985613739
- **TRK/TRANKI:** Provide contact info
- **JAPI/Hunter:** Provide contact info

**FLOW:**

1. If `handsOffStatus` already true → silent handoff
2. Detect product type from `priorityTransfer`
3. Voice → set transfer metadata → ESCALATE
4. Digital → display partner contact info → offer farewell

**TOOLS:**

- `FROM "./tools/code-transfer.tools.abl" USE: saveTransferSAC`
- `FROM "./tools/saludsa-zendesk.tools.abl" USE: create-zendesk-ticket`

### 8.15 Fallback_Handler

**File:** `agents/fallback_handler.agent.abl`
**LLM:** temperature: 0.1, top_p: 0.3, max_tokens: 10000

**Purpose:** Handle unrecognized/out-of-scope inputs.

**FLOW:**

```
entry_point: check_handoff
steps: [check_handoff, ask_clarification, present_menu]

check_handoff:
  REASONING: false
  - IF: handsOffStatus == true
    THEN: ESCALATE  # Silent handoff
  - ELSE:
    THEN: ask_clarification

ask_clarification:
  REASONING: false
  RESPOND: "No estoy seguro de entender su solicitud. ¿Podría reformular su pregunta?"
  GATHER:
    - userInput
      TYPE: string
      ASK: ""
  # Attempt to re-route (supervisor handles)
  # If returned here again (2nd time), present menu
  - IF: retry_count >= 2
    THEN: present_menu
  - ELSE:
    SET: retry_count = retry_count + 1
    THEN: COMPLETE  # Return to supervisor for re-routing

present_menu:
  REASONING: false
  CALL: update-zendesk-ticket(usecase: "transfer_sac", sessionId: session.sessionId)
  RESPOND: "Le puedo ayudar con las siguientes opciones:\n1. Dr. Salud\n2. Servicio al Cliente (SAC)\n3. Vitality\n4. Ventas\n\nPor favor seleccione una opción."
  GATHER:
    - menuSelection
      TYPE: string
      ASK: ""
  # Route based on selection → saveTransfer* → ESCALATE
```

**LIMITATIONS:**

- Must provide exactly 2 retries before showing menu
- Must not answer questions from own knowledge
- Check business hours before transfer

### 8.16 Farewell_Handler

**File:** `agents/farewell_handler.agent.abl`
**LLM:** temperature: 0.2, top_p: 1, max_tokens: 7000

**Purpose:** Graceful conversation closure.

**FLOW:**

```
entry_point: farewell
steps: [farewell]

farewell:
  REASONING: false
  CALL: close-zendesk-ticket(closing_reason: "self_service", sessionId: session.sessionId)
  RESPOND: "Ha sido un placer asistirle. ¡Que tenga un excelente {timeSlot}!"
  SET: closeConversation = "yes"
  THEN: COMPLETE
```

**CONSTRAINTS:**

```
always:
  - REQUIRE previous_system_message_was_offer == true
    ON_FAIL: "Farewell only triggers after an assistance offer"
  - REQUIRE NOT in_auth_flow
    ON_FAIL: "Never trigger during authentication"
  - REQUIRE NOT in_data_collection
    ON_FAIL: "Never trigger during data collection"
```

**LIMITATIONS:**

- Must use `{timeSlot}` from session memory for time-appropriate greeting
- Must close Zendesk ticket before farewell message

---

## 9. Events → ABL Mapping

### 9.1 End of Conversation → COMPLETE

Kore.ai's "End of Conversation" event terminates the session. In ABL, this maps to `COMPLETE` with `closeConversation == "yes"` in session memory. The ABL runtime should terminate the session when this flag is set.

**Parameters carried:**

- `conversationSummary` (LLM-generated)
- `closeConversation` (from `session.closeConversation`)
- `closeConversationMessage` (from `session.closeConversationMessage`)

### 9.2 Agent Handoff → ESCALATE

Kore.ai's "Agent Handoff" event transfers to a human agent. In ABL, this maps to `ESCALATE`. The ESCALATE payload must carry all context the contact center needs.

**Full ESCALATE context (all fields from Kore.ai Agent Handoff event):**

| Field                | Source                       | LLM-filled? |
| -------------------- | ---------------------------- | ----------- |
| conversationSummary  | LLM generates                | Yes         |
| conversationHistory  | LLM generates                | Yes         |
| sac_transfer_menu    | LLM generates                | Yes         |
| reason               | session.reason               | No          |
| ticketId             | session.ticketId             | No          |
| externalPhoneNumber  | session.externalPhoneNumber  | No          |
| queueName            | session.queueName            | No          |
| businessUnit         | session.businessUnit         | No          |
| agenticSessionId     | session.sessionId            | No          |
| highPriorityTransfer | session.highPriorityTransfer | No          |
| beneficiaryId        | session.beneficiaryId        | No          |
| beneficiaryName      | session.beneficiaryName      | No          |
| whatsAppLinkNumber   | session.whatsAppLinkNumber   | No          |
| customerName         | session.customerName         | No          |
| userPhoneNumber      | session.userPhoneNumber      | No          |
| userId               | session.userId               | No          |
| userEmail            | session.userEmail            | No          |
| sacMessage           | session.sacMessage           | No          |
| memberShipType       | session.memberShipType       | No          |
| customerDetails      | session.customerDetails      | No          |

### 9.3 Welcome Event → ON_START

Kore.ai's Welcome Event (disabled) maps to `ON_START` in the supervisor:

```
ON_START:
  RESPOND: TEMPLATE(welcome)
```

---

## 10. Per-Agent LLM Configuration

Each agent has individually tuned LLM settings from the Kore.ai export:

| Agent                   | ABL File                          | temperature | top_p | max_tokens |
| ----------------------- | --------------------------------- | ----------- | ----- | ---------- |
| Samy_Supervisor         | samy_supervisor.agent.abl         | 0.1         | 0.7   | 9999       |
| Client_Entry_Gateway    | client_entry_gateway.agent.abl    | 0.3         | 0.5   | 10000      |
| Broker_Entry_Gateway    | broker_entry_gateway.agent.abl    | 0.1         | 0.5   | 10000      |
| Transfer_Services       | transfer_services.agent.abl       | 0.3         | 0.5   | 10000      |
| Contract_Data_Assistant | contract_data_assistant.agent.abl | 0.1         | 0.5   | 10000      |
| Contract_Sending        | contract_sending.agent.abl        | 0.2         | 0.5   | 10000      |
| Pending_Payments        | pending_payments.agent.abl        | 0.3         | 0.5   | 10000      |
| Password_Reset          | password_reset.agent.abl          | 0.3         | 0.5   | 10000      |
| Refund_Guidance         | refund_guidance.agent.abl         | 0.1         | 0.5   | 10000      |
| Refund_Status           | refund_status.agent.abl           | 0.3         | 0.6   | 10000      |
| Coverage_Certificates   | coverage_certificates.agent.abl   | 0.3         | 0.5   | 10000      |
| Other_Services          | other_services.agent.abl          | 0.3         | 0.5   | 10000      |
| Transfer_To_Vitality    | transfer_to_vitality.agent.abl    | 0.3         | 1.0   | 10000      |
| Transfer_To_SAC         | transfer_to_sac.agent.abl         | 0.0         | 0.6   | 10000      |
| PCA_XPR_Transfer        | pca_xpr_transfer.agent.abl        | 0.1         | 0.5   | 10000      |
| Fallback_Handler        | fallback_handler.agent.abl        | 0.1         | 0.3   | 10000      |
| Farewell_Handler        | farewell_handler.agent.abl        | 0.2         | 1.0   | 7000       |

All agents use model `gpt-4.1`. Fallback model: `gpt-4o-mini`.

---

## 11. Localization

All user-facing strings are in Ecuadorian Spanish (formal "usted" register). Locale files at `locales/es/<agent_name>.json` contain:

- Greeting messages
- Error messages
- Validation prompts
- Menu options
- Farewell messages
- Status labels (Activo, Pendiente, Cancelado, etc.)
- Partner contact information

---

## 12. Unimplemented Gaps (`docs/unimplemented-gaps.md`)

Items that cannot be fully implemented in this port and must be documented:

### 12.1 Contact Center Adapter (In-Flight)

ESCALATE events carry the full context (queue, reason, ticketId, conversation summary, etc.) but the actual Kore.ai ContactCenter API integration (`CC_streamId`, `CC_accountId`) is being built separately. The ESCALATE contract is complete; the adapter that calls the CC API is not part of this port.

### 12.2 Channel Adapters

WhatsApp (Infobip webhook), Voice (SIP/Twilio), Web widget, iOS/Android SDK integration are platform infrastructure — separate from the agent DSL port.

### 12.3 SendMessageWhatsapp (Direct Infobip)

The `SendMessageWhatsapp` code tool calls Infobip API directly to send WhatsApp interactive button messages for Doctor Home Visit. This requires the WhatsApp channel adapter. In the ABL port, the agent FLOW step will RESPOND with the redirect text; actual interactive button delivery is a documented gap.

### 12.4 Pre-Processor Auto-Validation for Web/iOS/Android

Kore.ai pre-processors auto-validate digital channel users using `metadata.identificacion_app_web`. In ABL, the channel adapter should perform this validation and set `session.userValidation = true` before the supervisor sees the message. This is a channel adapter responsibility — documented as a gap.

### 12.5 PII Masking

ABL has no built-in PII detection or masking. The Password Reset agent needs to mask email and phone in responses. Implement as GUARDRAILS or document as gap.

### 12.6 Workflow Tools

Two Kore.ai WORKFLOW tools (`UpdateTicketTest`, `validateExpDental`) have no parameter schemas in the export. `validateExpDental` is mapped to `validarElegibilidadTarea` MCP tool with `codigoTarea: "Transferencia_Dental"`. `UpdateTicketTest` appears to be a test tool — omit from production.

### 12.7 Voice-Specific Behavior

Voice channel has specific behaviors: DTMF input, TTS responses, call transfer, Provider role handling (immediate transfer to `Voz_Emergencias_y_Urgencias`). These require the Voice channel adapter and are documented as gaps.

### 12.8 Content Variables

Kore.ai has a global content variable `mcpServer` used as a tool prefix instruction. In ABL, this is handled by the tool registry configuration — no gap, but noted for completeness.
