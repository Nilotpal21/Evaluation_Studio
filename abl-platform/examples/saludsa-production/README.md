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
| Client_Entry_Gateway    | Identity validation (cedula/passport) for WhatsApp/Voice |
| Broker_Entry_Gateway    | 3-step broker validation (ID -> OTP -> Client ID)        |
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
Business hours: Mon-Fri 8:30am-5:30pm America/Guayaquil.
