# Architecture: saludsaapptemp

## Pattern: Multi-Agent Supervisor (Unified AgentIR)

All agents — including the supervisor — compile into the same `AgentIR` type and live in a single registry. The supervisor is identified by having `routing` configuration (populated from HANDOFF rules). This unified design enables hierarchical composition and config-driven routing detection.

Eres Samy, el asistente virtual de Saludsa, diseñado para responder y atender las preguntas, consultas y solicitudes de los usuarios relacionadas con los planes de salud prepago. Ofrece soporte de autoservicio, orientación sobre beneficios, cobertura, pagos y trámites, y atiende solicitudes comunes de forma rápida, segura y disponible las 24 horas, los 7 días de la semana. No debe modificar, reformular ni añadir información a las respuestas de cada agente. Solo debe mostrar la respuesta exacta del agente, sin manipulaciones, contexto adicional ni explicaciones

## Supervisor

**Supervisor**: Route user requests to the appropriate specialist agent based on intent analysis

### Routing Rules

| Priority | Target Agent                            | Condition                                                                      | Returns |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------ | ------- |
| 1        | Farewell_Handler                        | `intent contains "information"`                                                | No      |
| 2        | Password_Reset_Agent                    | `intent contains "routing user requests to appropriate specialized agents"`    | No      |
| 3        | Transfer_Services                       | `intent contains "priorityTransfer is either PCA"`                             | No      |
| 4        | Fallback_Handler                        | `intent contains "information"`                                                | No      |
| 5        | Transfer_To_Vitality                    | `intent contains "priorityTransfer is either PCA"`                             | No      |
| 6        | Refund_Guidance_Agent                   | `intent contains "routing user requests to appropriate specialized agents"`    | No      |
| 7        | Contract_Sending_Agent                  | `intent contains "routing user requests to appropriate specialized agents"`    | No      |
| 8        | Other_Services                          | `intent contains "all other intents"`                                          | No      |
| 9        | Greetings_Br_And_Broker                 | `intent contains "information"`                                                | No      |
| 10       | Contract_Data_Assistant                 | `intent.category == "contract_data_assistant"`                                 | No      |
| 11       | Transfer_To_Sac                         | `intent contains "priorityTransfer is either PCA"`                             | No      |
| 12       | Refund_Status                           | `intent contains "isUserValidated IS NOT true AND handsOffStatus IS NOT true"` | No      |
| 13       | Whatsapp_User_Check                     | `intent contains "routing user requests to appropriate specialized agents"`    | No      |
| 14       | Pca_And_Xpr_Associated_Product_Transfer | `intent contains "priorityTransfer is either PCA"`                             | No      |

## Agent Details

### Farewell_Handler

- **Mode**: reasoning
- **Goal**: role:
- **Tools**: None
- **Gather fields**: None

### Password_Reset_Agent

- **Mode**: reasoning
- **Goal**: Hi!
- **Tools**: `saludsa_mcp_server_validate_otp`, `saludsa_mcp_server_password_reset`
- **Gather fields**: None

### Transfer_Services

- **Mode**: reasoning
- **Goal**: - DRSALUDAUTORIZATION
- **Tools**: `saludsa_mcp_server_validate_task_eligibility`, `saludsa_mcp_server_update_zendesk_ticket`, `saludsa_mcp_server_validateoutofhours`, `saludsa_mcp_server_send_email_template`
- **Gather fields**: None

### Pending_Payments_Amount

- **Mode**: reasoning
- **Goal**: Hello!
- **Tools**: `saludsa_mcp_server_pending_payments`, `saludsa_mcp_server_update_zendesk_ticket`
- **Gather fields**: None

### Fallback_Handler

- **Mode**: reasoning
- **Goal**: role:
- **Tools**: `saludsa_mcp_server_update_zendesk_ticket`
- **Gather fields**: None

### Transfer_To_Vitality

- **Mode**: reasoning
- **Goal**: \*\*CRITICAL: You MUST execute ALL steps in the exact sequence listed below.
- **Tools**: None
- **Gather fields**: None

### Refund_Guidance_Agent

- **Mode**: reasoning
- **Goal**: 🎯 Purpose: My primary goal is to make the reimbursement process easy, accurate, and contextual.
- **Tools**: `saludsa_mcp_server_steps_for_refund`
- **Gather fields**: None

### Contract_Sending_Agent

- **Mode**: reasoning
- **Goal**: Hello!
- **Tools**: `saludsa_mcp_server_get_security_questions`, `saludsa_mcp_server_sending_contracts`
- **Gather fields**: None

### Other_Services

- **Mode**: reasoning
- **Goal**: - DENTAL_COVERAGE
- **Tools**: `saludsa_mcp_server_validar_elegibilidad_tarea`, `saludsa_mcp_server_validate_task_eligibility`, `saludsa_mcp_server_update_zendesk_ticket`
- **Gather fields**: None

### Greetings_Br_And_Broker

- **Mode**: reasoning
- **Goal**: role:
- **Tools**: None
- **Gather fields**: None

### Contract_Data_Assistant

- **Mode**: reasoning
- **Goal**: Hello!
- **Tools**: `saludsa_mcp_server_contract_status`, `saludsa_mcp_server_get_security_questions`, `saludsa_mcp_server_update_zendesk_ticket`
- **Gather fields**: None

### Transfer_To_Sac

- **Mode**: reasoning
- **Goal**: Hello!
- **Tools**: `saludsa_mcp_server_update_zendesk_ticket`
- **Gather fields**: None

### Refund_Status

- **Mode**: reasoning
- **Goal**: Your responsibility is to locate, validate, and explain the status of medical expense refunds, strictly following the...
- **Tools**: `saludsa_mcp_server_resend_refund_settlement`, `saludsa_mcp_server_prioritize_refund_zendesk`, `saludsa_mcp_server_check_refund_status`, `saludsa_mcp_server_update_zendesk_ticket`
- **Gather fields**: None

### Issuance_Of_Coverage_Certificates_Coverage_Travel

- **Mode**: reasoning
- **Goal**: Hello!
- **Tools**: `saludsa_mcp_server_get_security_questions`, `saludsa_mcp_server_check_coverage_eligibility`, `saludsa_mcp_server_update_zendesk_ticket`, `saludsa_mcp_server_get_coverage_certificate`, `saludsa_mcp_server_send_email_template`
- **Gather fields**: None

### Whatsapp_User_Check

- **Mode**: reasoning
- **Goal**: role:
- **Tools**: None
- **Gather fields**: None

### Pca_And_Xpr_Associated_Product_Transfer

- **Mode**: reasoning
- **Goal**: Hello!
- **Tools**: None
- **Gather fields**: None
