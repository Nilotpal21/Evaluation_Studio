# saludsaapptemp

Eres Samy, el asistente virtual de Saludsa, diseñado para responder y atender las preguntas, consultas y solicitudes de los usuarios relacionadas con los planes de salud prepago. Ofrece soporte de autoservicio, orientación sobre beneficios, cobertura, pagos y trámites, y atiende solicitudes comunes de forma rápida, segura y disponible las 24 horas, los 7 días de la semana. No debe modificar, reformular ni añadir información a las respuestas de cada agente. Solo debe mostrar la respuesta exacta del agente, sin manipulaciones, contexto adicional ni explicaciones

## Architecture

**Pattern**: Multi-Agent Supervisor (Unified AgentIR)

All agents compile into the same `AgentIR` type. The supervisor is an agent with routing configuration — detected by `ir.routing?.rules?.length > 0`, not type metadata.

### Agents

| Agent                                             | Mode      | Description                                                                                                              |
| ------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Farewell_Handler                                  | reasoning | role:                                                                                                                    |
| Password_Reset_Agent                              | reasoning | Hi!                                                                                                                      |
| Transfer_Services                                 | reasoning | - DRSALUDAUTORIZATION                                                                                                    |
| Pending_Payments_Amount                           | reasoning | Hello!                                                                                                                   |
| Fallback_Handler                                  | reasoning | role:                                                                                                                    |
| Transfer_To_Vitality                              | reasoning | \*\*CRITICAL: You MUST execute ALL steps in the exact sequence listed below.                                             |
| Refund_Guidance_Agent                             | reasoning | 🎯 Purpose: My primary goal is to make the reimbursement process easy, accurate, and contextual.                         |
| Contract_Sending_Agent                            | reasoning | Hello!                                                                                                                   |
| Other_Services                                    | reasoning | - DENTAL_COVERAGE                                                                                                        |
| Greetings_Br_And_Broker                           | reasoning | role:                                                                                                                    |
| Contract_Data_Assistant                           | reasoning | Hello!                                                                                                                   |
| Transfer_To_Sac                                   | reasoning | Hello!                                                                                                                   |
| Refund_Status                                     | reasoning | Your responsibility is to locate, validate, and explain the status of medical expense refunds, strictly following the... |
| Issuance_Of_Coverage_Certificates_Coverage_Travel | reasoning | Hello!                                                                                                                   |
| Whatsapp_User_Check                               | reasoning | role:                                                                                                                    |
| Pca_And_Xpr_Associated_Product_Transfer           | reasoning | Hello!                                                                                                                   |

## Quick Start

1. Review the architecture in `docs/architecture.md`
2. Check known limitations in `docs/limitations.md`
3. Load the supervisor ABL file in your runtime
4. Configure tool implementations for your backend

## Project Structure

```
saludsaapptemp/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── best-practices.md
│   ├── limitations.md
│   └── deployment.md
├── supervisor.agent.abl
└── agents/
    ├── farewell_handler.agent.abl
    ├── password_reset_agent.agent.abl
    ├── transfer_services.agent.abl
    ├── pending_payments_amount.agent.abl
    ├── fallback_handler.agent.abl
    ├── transfer_to_vitality.agent.abl
    ├── refund_guidance_agent.agent.abl
    ├── contract_sending_agent.agent.abl
    ├── other_services.agent.abl
    ├── greetings_br_and_broker.agent.abl
    ├── contract_data_assistant.agent.abl
    ├── transfer_to_sac.agent.abl
    ├── refund_status.agent.abl
    ├── issuance_of_coverage_certificates_coverage_travel.agent.abl
    ├── whatsapp_user_check.agent.abl
    └── pca_and_xpr_associated_product_transfer.agent.abl
```

## Documentation

- [Architecture Overview](docs/architecture.md)
- [Best Practices](docs/best-practices.md)
- [Limitations & Gaps](docs/limitations.md)
- [Deployment Guide](docs/deployment.md)
